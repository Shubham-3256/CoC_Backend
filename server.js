// server.js (Redis-free clean version)
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

// Use native fetch if available, otherwise import node-fetch
const fetchFn = global.fetch || (await import("node-fetch")).default;

// ------------ Middleware ------------
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "10kb" }));
app.use(morgan("combined"));

// ------------ CORS ------------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------ Rate Limit ------------
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15000),
  max: Number(process.env.RATE_LIMIT_MAX || 100),
  standardHeaders: true,
}));

// ------------ Local Cache ------------
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 30);
const cache = new NodeCache({ stdTTL: CACHE_TTL });

async function getCache(key) {
  return cache.get(key) || null;
}
async function setCache(key, value) {
  cache.set(key, value);
}

// ------------ Utility ------------
function encodeTag(tag) {
  if (!tag) return "";
  if (!tag.startsWith("#")) tag = `#${tag}`;
  return encodeURIComponent(tag);
}

async function fetchWithTimeout(url, opts = {}, timeout = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetchFn(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function cocFetch(path, req, res, { cacheKey = null, method = "GET", body = null } = {}) {
  try {
    if (cacheKey) {
      const c = await getCache(cacheKey);
      if (c) return res.status(c.status).json(c.body);
    }

    const url = `${COC_API}${path}`;
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    const json = text ? JSON.parse(text) : {};

    if (cacheKey) {
      await setCache(cacheKey, { status: response.status, body: json });
    }

    return res.status(response.status).json(json);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}

// ------------ Routes ------------
app.get("/", (req, res) => res.send("Clash of Clans Proxy Running!"));
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// Clan
app.get("/clan/:tag", (req, res) => {
  const tag = encodeTag(req.params.tag);
  cocFetch(`/clans/${tag}`, req, res, { cacheKey: `clan:${tag}` });
});
app.get("/clan/:tag/members", (req, res) => {
  const tag = encodeTag(req.params.tag);
  cocFetch(`/clans/${tag}/members`, req, res, { cacheKey: `members:${tag}` });
});
app.get("/clan/:tag/warlog", (req, res) => {
  const tag = encodeTag(req.params.tag);
  cocFetch(`/clans/${tag}/warlog`, req, res, { cacheKey: `warlog:${tag}` });
});
app.get("/clan/:tag/currentwar", (req, res) => {
  const tag = encodeTag(req.params.tag);
  cocFetch(`/clans/${tag}/currentwar`, req, res, { cacheKey: `currentwar:${tag}` });
});

// Players
app.get("/player/:tag", (req, res) => {
  const tag = encodeTag(req.params.tag);
  cocFetch(`/players/${tag}`, req, res, { cacheKey: `player:${tag}` });
});
app.get("/player/:tag/battlelog", (req, res) => {
  const tag = encodeTag(req.params.tag);
  cocFetch(`/players/${tag}/battlelog`, req, res, { cacheKey: `battlelog:${tag}` });
});

// -------- Start --------
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
