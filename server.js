// server.js (ESM)
import express from "express";
import cors from "cors";
import pino from "pino";
import { RateLimiterMemory } from "rate-limiter-flexible";
import dotenv from "dotenv";
import { execSync } from "child_process";

dotenv.config();

// === AUTO-INSTALL CHROMIUM AT RUNTIME ===
try {
  console.log("🧩 Checking Chromium installation...");
  execSync("npx playwright install chromium", { stdio: "inherit" });
  console.log("✅ Chromium installed or already available.");
} catch (e) {
  console.warn("⚠️ Playwright Chromium install failed, continuing anyway.", e);
}

const log = pino();
const app = express();

app.use(cors());
app.use(express.json());

// === RATE LIMITER ===
const limiter = new RateLimiterMemory({
  points: Number(process.env.RATE_LIMIT_POINTS || 60),
  duration: Number(process.env.RATE_LIMIT_DURATION || 60),
});

// === SIGNER HOLDER ===
let signer = null;
let signerReady = false;
let signerInfo = { source: null };

// === LOAD SIGNER FUNCTION ===
async function loadSigner() {
  if (signerReady) return;
  try {
    const mod = await import("tiktok-signature");
    signerInfo.source = "tiktok-signature";

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
          sign: typeof instance.sign === "function"
            ? instance.sign.bind(instance)
            : instance.generate
            ? instance.generate.bind(instance)
            : null,
          init: typeof instance.init === "function" ? instance.init.bind(instance) : null,
        };
      } else if (typeof mod.default.sign === "function") {
        signer = {
          sign: mod.default.sign.bind(mod.default),
          init: typeof mod.default.init === "function" ? mod.default.init.bind(mod.default) : null,
        };
      }
    }

    // === INIT SIGNER (Playwright) ===
    if (signer && signer.init) {
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
        log.warn({ err: e }, "Signer init() failed — continuing anyway.");
      }
    }

    if (!signer || typeof signer.sign !== "function") {
      log.warn("Signer invalid or missing sign() method.");
      signer = null;
    } else {
      signerReady = true;
      log.info({ source: signerInfo.source }, "✅ Signer loaded successfully.");
    }
  } catch (err) {
    log.warn({ err }, "No compatible signer found. Install github:carcabot/tiktok-signature.");
    signer = null;
    signerReady = false;
  }
}

// === AUTO-RELOAD SIGNER ON CRASH ===
process.on("uncaughtException", async (err) => {
  console.error("❌ Uncaught exception:", err);
  if (err.message?.includes("browserType.launch")) {
    console.log("🔁 Reinitializing signer after browser crash...");
    signerReady = false;
    signer = null;
    await loadSigner();
  }
});

// === INITIAL LOAD ===
loadSigner().catch((e) => log.error({ e }, "Signer loader failed"));

// === RATE LIMIT MIDDLEWARE ===
app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    return next();
  } catch {
    return res.status(429).json({ success: false, error: "Too many requests" });
  }
});

// === HEALTH CHECK ===
app.get("/", (req, res) => {
  res.json({
    success: true,
    ready: signerReady,
    signerInfo,
    timestamp: Date.now(),
  });
});

// === SIGN ENDPOINT ===
app.all("/sign", async (req, res) => {
  try {
    const url = (req.method === "GET" ? req.query.url : req.body?.url) || null;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ success: false, error: "Missing 'url' parameter" });
    }

    if (!signerReady) await loadSigner();
    if (!signer || typeof signer.sign !== "function") {
      return res.status(503).json({ success: false, error: "Signer not available" });
    }

    let result;
    try {
      result = await signer.sign(url);
    } catch (err) {
      if (signer.instance?.generate) result = await signer.instance.generate(url);
      else if (signer.instance?.signUrl) result = await signer.instance.signUrl(url);
      else throw err;
    }

    if (!result) return res.status(500).json({ success: false, error: "Empty result from signer" });

    let signedUrl = null;
    let signature = null;

    if (typeof result === "string") {
      signedUrl = result;
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

    if (!signedUrl)
      return res.status(500).json({ success: false, error: "Could not normalize signer output", raw: result });

    const out = { success: true, signedUrl, signature, timestamp: Date.now(), raw: result };

    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter((p) => p);
    const endpoint = pathParts.at(-1) || "root";
    console.log(`🔐 SIGNED: ${endpoint} | X-Bogus: ${signature?.slice(0, 12)}... | ${new Date().toLocaleTimeString()}`);

    return res.json(out);
  } catch (err) {
    log.error({ err }, "Sign endpoint error");
    return res.status(500).json({ success: false, error: "Sign error", details: String(err) });
  }
});

// === RELOAD SIGNER MANUALLY ===
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
  log.info(`🚀 Sign server listening on ${PORT} (signerReady=${signerReady})`);
});
