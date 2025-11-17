// server.js — Improved error handling + configurable
// Based on your previous server.js. Keeps no added npm deps.
// Reference: original server.js used as base. :contentReference[oaicite:1]{index=1}

import express from "express";
import dotenv from "dotenv";
import morgan from "morgan";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const COC_API = "https://api.clashofclans.com/v1";
const TOKEN = process.env.COC_TOKEN;

if (!TOKEN) {
  console.error("❌ Missing COC_TOKEN. Add it in Render dashboard under Environment Variables.");
  process.exit(1);
}

// feature flags / config (easy to extend)
const DEBUG = (process.env.DEBUG || "false").toLowerCase() === "true";
const ALLOW_RAW_PROXY = (process.env.ALLOW_RAW_PROXY || "false").toLowerCase() === "true";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 30);
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 100);
const JSON_LIMIT = process.env.JSON_BODY_LIMIT || "10kb";

// small in-memory metrics (useful before adding real metrics)
const metrics = {
  totalRequests: 0,
  successes: 0,
  errors: 0,
  cacheHits: 0,
  lastError: null,
};

// simple console logger respecting DEBUG flag
function log(...args) {
  if (DEBUG) console.debug(...args);
}
function info(...args) {
  console.log(...args);
}
function warn(...args) {
  console.warn(...args);
}
function errorLog(...args) {
  console.error(...args);
  metrics.lastError = { when: Date.now(), msg: args.map(a => String(a)).join(" ") };
}

// ---------- polyfill fetch if not present ----------
const fetchFn = global.fetch || (await import("node-fetch")).default;

// ---------- middleware ----------
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: JSON_LIMIT }));
app.use(morgan(process.env.MORGAN_FORMAT || (DEBUG ? "dev" : "combined")));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Request-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// rate limiter (basic)
app.use(rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX,
  standardHeaders: true,
}));

// NodeCache (in-memory) - easy to swap to Redis later
const cache = new NodeCache({ stdTTL: CACHE_TTL });

// ---------- helpers ----------

// generate simple request id (timestamp + short random)
function makeRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
}

// wrap async route handlers to forward errors to central handler
const wrap = (fn) => (req, res, next) => {
  const requestId = makeRequestId();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  metrics.totalRequests += 1;
  Promise.resolve(fn(req, res, next)).catch(next);
};

// basic param validator for Clash tags (server expects encoded '#TAG' later)
function validateTagParam(raw) {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "missing tag" };
  // allow letters, numbers, #, %, - and up to 40 chars (safe limit)
  if (!/^[#%0-9A-Za-z\-]+$/.test(raw)) return { ok: false, reason: "invalid characters in tag" };
  if (raw.length > 40) return { ok: false, reason: "tag too long" };
  return { ok: true };
}

function encodeTag(tag) {
  if (!tag) return "";
  const withHash = tag.startsWith("#") || tag.startsWith("%23") ? tag : `#${tag}`;
  return encodeURIComponent(withHash);
}

// safe JSON parse, returns { ok, json, raw }
function safeJsonParse(text) {
  try {
    const j = text ? JSON.parse(text) : {};
    return { ok: true, json: j, raw: text };
  } catch (err) {
    return { ok: false, json: null, raw: text };
  }
}

// fetch with timeout
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return resp;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// improved cocFetch: returns response to client with proper status + structured error info
async function cocFetch(path, req, res, { cacheKey = null, method = "GET", body = null, allowedQueryParams = [] } = {}) {
  const requestId = req.requestId || makeRequestId();
  try {
    // cache short-circuit
    if (cacheKey && method === "GET") {
      const c = cache.get(cacheKey);
      if (c) {
        metrics.cacheHits += 1;
        log(`[cache] hit ${cacheKey} req=${requestId}`);
        return res.status(c.status).json({ ...c.body, _cached: true });
      }
    }

    // build URL (no query builder here, add if needed)
    const url = `${COC_API}${path}`;

    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
        "User-Agent": process.env.USER_AGENT || "clash-proxy/1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    }, Number(process.env.FETCH_TIMEOUT_MS || 6000));

    const text = await response.text();
    const parsed = safeJsonParse(text);

    // if the response is not JSON, wrap raw
    const payload = parsed.ok ? parsed.json : { raw: parsed.raw };

    // If upstream returns 429 (rate limit) include retry info
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const rateInfo = { retryAfter: retryAfter || null, note: "Upstream rate-limited (429)" };
      const bodyToSend = { error: "rate_limited", rateInfo, upstream: payload };
      if (cacheKey) cache.set(cacheKey, { status: response.status, body: bodyToSend }, CACHE_TTL);
      metrics.errors += 1;
      return res.status(429).json({ ...bodyToSend, requestId });
    }

    // cache successful GETs (200-299)
    if (cacheKey && response.status >= 200 && response.status < 300) {
      cache.set(cacheKey, { status: response.status, body: payload }, CACHE_TTL);
    }

    metrics.successes += 1;
    return res.status(response.status).json({ ...payload, requestId });
  } catch (err) {
    metrics.errors += 1;
    errorLog(`[cocFetch] req=${requestId} err=`, err && err.message ? err.message : err);
    const isAbort = err && err.name === "AbortError";
    const status = isAbort ? 504 : 500;
    // Provide helpful structured error to client
    return res.status(status).json({
      error: isAbort ? "upstream_timeout" : "upstream_error",
      message: err.message || "Unknown error",
      requestId,
    });
  }
}

// ---------- routes ----------
// root & health
app.get("/", (req, res) => res.send("Clash of Clans Proxy Running (improved error handling)."));
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), requestId: req.requestId || null }));

// metrics for quick diagnostics
app.get("/metrics", (req, res) => res.json(metrics));

// Search (example: keep as-is, you can extend allowedQueryParams)
app.get("/search/clans", wrap(async (req, res) => {
  const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
  return cocFetch(`/clans${qs}`, req, res, { cacheKey: `search:clans:${qs}` });
}));

// Clan endpoints with validation
app.get("/clan/:tag", wrap(async (req, res) => {
  const v = validateTagParam(req.params.tag);
  if (!v.ok) return res.status(400).json({ error: "invalid_tag", reason: v.reason, requestId: req.requestId });

  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}`, req, res, { cacheKey: `clan:${tag}` });
}));

app.get("/clan/:tag/members", wrap(async (req, res) => {
  const v = validateTagParam(req.params.tag);
  if (!v.ok) return res.status(400).json({ error: "invalid_tag", reason: v.reason, requestId: req.requestId });

  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/members`, req, res, { cacheKey: `members:${tag}` });
}));

app.get("/clan/:tag/warlog", wrap(async (req, res) => {
  const v = validateTagParam(req.params.tag);
  if (!v.ok) return res.status(400).json({ error: "invalid_tag", reason: v.reason, requestId: req.requestId });

  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/warlog`, req, res, { cacheKey: `warlog:${tag}` });
}));

app.get("/clan/:tag/currentwar", wrap(async (req, res) => {
  const v = validateTagParam(req.params.tag);
  if (!v.ok) return res.status(400).json({ error: "invalid_tag", reason: v.reason, requestId: req.requestId });

  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/currentwar`, req, res, { cacheKey: `currentwar:${tag}` });
}));

// Players
app.get("/player/:tag", wrap(async (req, res) => {
  const v = validateTagParam(req.params.tag);
  if (!v.ok) return res.status(400).json({ error: "invalid_tag", reason: v.reason, requestId: req.requestId });

  const tag = encodeTag(req.params.tag);
  return cocFetch(`/players/${tag}`, req, res, { cacheKey: `player:${tag}` });
}));

app.get("/player/:tag/battlelog", wrap(async (req, res) => {
  const v = validateTagParam(req.params.tag);
  if (!v.ok) return res.status(400).json({ error: "invalid_tag", reason: v.reason, requestId: req.requestId });

  const tag = encodeTag(req.params.tag);
  return cocFetch(`/players/${tag}/battlelog`, req, res, { cacheKey: `battlelog:${tag}` });
}));

// Optional raw proxy (disabled by default for safety)
if (ALLOW_RAW_PROXY) {
  app.get("/raw/*", wrap(async (req, res) => {
    const path = req.path.replace(/^\/raw/, "");
    // basic sanitization
    if (!/^[\w\-\/%\.]+$/.test(path)) {
      return res.status(400).json({ error: "invalid_raw_path", requestId: req.requestId });
    }
    return cocFetch(path, req, res, { cacheKey: `raw:${path}:${req.originalUrl}` });
  }));
}

// ---------- 404 handler ----------
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.originalUrl, requestId: req.requestId || null });
});

// ---------- central error handler ----------
app.use((err, req, res, next) => {
  const requestId = req.requestId || makeRequestId();
  metrics.errors += 1;
  errorLog(`[error] req=${requestId} err=`, err && err.stack ? err.stack : err);
  const status = err && err.status ? err.status : 500;
  const payload = {
    error: err && err.code ? err.code : "internal_error",
    message: err && err.message ? err.message : "Internal server error",
    requestId,
  };
  res.status(status).json(payload);
});

// ---------- start ----------
app.listen(PORT, () => {
  info(`✅ Backend running on port ${PORT} (DEBUG=${DEBUG})`);
});
