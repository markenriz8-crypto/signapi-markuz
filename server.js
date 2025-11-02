// server.js (ESM)
import express from "express";
import cors from "cors";
import pino from "pino";
import { RateLimiterMemory } from "rate-limiter-flexible";
import dotenv from "dotenv";

dotenv.config();

const log = pino();
const app = express();

app.use(cors());
app.use(express.json());

// Rate limiter (per IP)
const limiter = new RateLimiterMemory({
  points: Number(process.env.RATE_LIMIT_POINTS || 60), // requests
  duration: Number(process.env.RATE_LIMIT_DURATION || 60), // seconds
});

// Signer holder
let signer = null;
let signerReady = false;
let signerInfo = { source: null };

// Helper: attempt to dynamically import a signer implementation.
// Recommended install: npm i github:carcabot/tiktok-signature
async function loadSigner() {
  if (signerReady) return;
  try {
    // Try to import the common package name first
    // Users should install one of the compatible signer packages or github repo.
    // Example: npm i github:carcabot/tiktok-signature
    const mod = await import("tiktok-signature");
    signerInfo.source = "tiktok-signature";
    // The module can export either:
    // - an async function sign(url)
    // - an object/class with init() and sign()/generate() methods
    if (typeof mod.sign === "function") {
      signer = {
        sign: mod.sign.bind(mod),
        init: typeof mod.init === "function" ? mod.init.bind(mod) : null,
      };
    } else if (mod.default) {
      const Default = mod.default;
      if (typeof Default === "function") {
        const instance = new Default();
        signer = {
          instance,
          sign: typeof instance.sign === "function" ? instance.sign.bind(instance) : (instance.generate ? instance.generate.bind(instance) : null),
          init: typeof instance.init === "function" ? instance.init.bind(instance) : null,
        };
      } else if (typeof mod.default.sign === "function") {
        signer = {
          sign: mod.default.sign.bind(mod.default),
          init: typeof mod.default.init === "function" ? mod.default.init.bind(mod.default) : null,
        };
      }
    }
    // If a signer requires initialization (puppeteer), call init with recommended options.
    if (signer && signer.init) {
      // Provide safe default launch options for common cloud hosts
      try {
        await signer.init?.({
          launchOptions: {
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--single-process",
            ],
          },
        });
      } catch (e) {
        log.warn({ err: e }, "Signer init() threw an error (continuing; sign() may still work)");
      }
    }

    if (!signer || typeof signer.sign !== "function") {
      log.warn("Imported module did not expose a usable .sign function. Signer not ready.");
      signer = null;
    } else {
      signerReady = true;
      log.info({ source: signerInfo.source }, "Signer loaded and ready");
    }
  } catch (err) {
    // No installed signer found
    log.warn({ err }, "No compatible signer package found. Install github:carcabot/tiktok-signature (or compatible fork).");
    signer = null;
    signerReady = false;
  }
}

// call loader at startup (non-blocking)
loadSigner().catch((e) => log.error({ e }, "Signer loader failed"));

// Middleware: basic rate-limit
app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    return next();
  } catch (err) {
    res.status(429).json({ success: false, error: "Too many requests" });
  }
});

// Health
app.get("/", (req, res) => {
  res.json({
    success: true,
    ready: signerReady,
    signerInfo,
    timestamp: Date.now(),
  });
});

// GET or POST /sign
// GET: /sign?url=...
// POST: { "url": "..." }
app.all("/sign", async (req, res) => {
  try {
    // check query/body
    const url = (req.method === "GET" ? req.query.url : req.body?.url) || null;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ success: false, error: "Missing 'url' parameter" });
    }

    // ensure signer loaded - try to load on-demand
    if (!signerReady) {
      await loadSigner();
    }

    if (!signer || typeof signer.sign !== "function") {
      // optional proxy fallback if you want to use a public signer
      const proxyFallback = process.env.SIGN_PROXY_FALLBACK || "";
      if (proxyFallback) {
        // proxy to fallback signer
        try {
          const fallbackUrl = `${proxyFallback}?url=${encodeURIComponent(url)}`;
          log.info("Proxying sign request to fallback:", fallbackUrl);
          const fetch = (await import("node-fetch")).default;
          const r = await fetch(fallbackUrl, { method: "GET" });
          const body = await r.json();
          return res.status(r.status).json(body);
        } catch (err) {
          log.error({ err }, "Proxy fallback failed");
          return res.status(502).json({ success: false, error: "Proxy fallback failed" });
        }
      }

      return res.status(503).json({
        success: false,
        error:
          "Signer not available. Install a compatible signer (e.g. github:carcabot/tiktok-signature) and restart the server.",
      });
    }

    // signer.sign may accept (url) and return various shapes.
    let result;
    try {
      result = await signer.sign(url);
    } catch (err) {
      // Some implementations expose different method names (generate/signUrl)
      if (signer.instance && typeof signer.instance.generate === "function") {
        result = await signer.instance.generate(url);
      } else if (signer.instance && typeof signer.instance.signUrl === "function") {
        result = await signer.instance.signUrl(url);
      } else {
        throw err;
      }
    }

    // Normalize result: library may return string or object
    let signedUrl = null;
    let signature = null;
    if (!result) {
      return res.status(500).json({ success: false, error: "Signer returned empty result" });
    }

    if (typeof result === "string") {
      signedUrl = result;
      // try to extract X-Bogus param if present
      try {
        const u = new URL(result);
        signature = u.searchParams.get("X-Bogus") || null;
      } catch {
        signature = null;
      }
    } else if (typeof result === "object") {
      signedUrl = result.signed_url ?? result.signedUrl ?? result.url ?? result.endpoint ?? null;
      signature = result.signature ?? result.X_Bogus ?? result.x_bogus ?? null;
    }

    // If still no signedUrl, try to compute from result.raw or fallback
    if (!signedUrl && result.raw && typeof result.raw === "string") {
      signedUrl = result.raw;
    }

    if (!signedUrl) {
      return res.status(500).json({ success: false, error: "Could not normalize signer output", raw: result });
    }

    // success
    const out = {
      success: true,
      signedUrl,
      signature,
      timestamp: Date.now(),
      raw: result,
    };
    // Enhanced logging to show real activity
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    const endpoint = pathParts.length > 0 ? pathParts[pathParts.length - 1] : 'root';
    const params = urlObj.search ? `?${urlObj.searchParams.get('aid') || 'params'}` : '';
    console.log(`🔐 SIGNED: ${endpoint}${params} | X-Bogus: ${signature?.substring(0, 16)}... | ${new Date().toLocaleTimeString()}`);
    
    return res.json(out);
  } catch (err) {
    log.error({ err }, "Sign endpoint error");
    return res.status(500).json({ success: false, error: "Sign error", details: String(err) });
  }
});

// Optional admin route to re-load signer without restarting process
app.post("/_reload_signer", async (req, res) => {
  try {
    signerReady = false;
    signer = null;
    await loadSigner();
    return res.json({ success: true, ready: signerReady, signerInfo });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  log.info(`Sign server listening on ${PORT} (signerReady=${signerReady})`);
});