// server.js (updated)
// Drop this file into your project replacing the old server.js
import express from "express";
import dotenv from "dotenv";
import morgan from "morgan";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";
import Redis from "ioredis";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const COC_API = "https://api.clashofclans.com/v1";
const TOKEN = process.env.COC_TOKEN;

if (!TOKEN) {
  console.error("❌ Missing COC_TOKEN environment variable. Create a token at developer.clashofclans.com and set COC_TOKEN.");
  process.exit(1);
}

// fetchFn: use global.fetch if available, otherwise import node-fetch dynamically
const fetchFn = global.fetch || (await import("node-fetch")).default;

// ---------- Basic middleware ----------
app.use(helmet());
app.use(compression());
// limit JSON body size to prevent large payload abuse
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "10kb" }));
app.use(morgan(process.env.MORGAN_FORMAT || "combined"));

// ---------- CORS ----------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Rate limiter (configurable via env) ----------
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 1000), // default 15s
  max: Number(process.env.RATE_LIMIT_MAX || 100), // default 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ---------- Cache: NodeCache fallback or Redis if REDIS_URL provided ----------
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 30);
let redis = null;
let nodeCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: Math.max(5, Math.floor(CACHE_TTL * 0.2)) });

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on("error", (err) => console.error("Redis error:", err));
  console.log("🔁 Using Redis for cache:", process.env.REDIS_URL);
} else {
  console.log("🔁 Using in-memory NodeCache for cache (single-instance).");
}

async function getCache(key) {
  if (!key) return null;
  if (redis) {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  } else {
    return nodeCache.get(key) ?? null;
  }
}
async function setCache(key, value, ttlSec = CACHE_TTL) {
  if (!key) return;
  if (redis) {
    await redis.set(key, JSON.stringify(value), "EX", Math.max(1, ttlSec));
  } else {
    nodeCache.set(key, value, ttlSec);
  }
}
async function delCache(key) {
  if (!key) return;
  if (redis) {
    await redis.del(key);
  } else {
    nodeCache.del(key);
  }
}

// ---------- Utilities ----------
function encodeTag(raw) {
  if (!raw) return "";
  if (raw.startsWith("%23")) return raw;
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  return encodeURIComponent(withHash);
}

function qsFrom(req, allowed = []) {
  const params = new URLSearchParams();
  for (const k of allowed) {
    if (req.query[k] !== undefined) params.append(k, req.query[k]);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// fetch with timeout + retry/backoff
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function cocFetch(path, req, res, { method = "GET", body = null, cacheKey = null, allowedQueryParams = [] } = {}) {
  try {
    const qs = qsFrom(req, allowedQueryParams);
    const url = `${COC_API}${path}${qs}`;

    const shouldCache = method === "GET" && cacheKey;
    if (shouldCache) {
      const cached = await getCache(cacheKey);
      if (cached) {
        // return cached response (status + body)
        return res.status(cached.status).json(cached.body);
      }
    }

    // Retry with exponential backoff
    const maxAttempts = Number(process.env.FETCH_RETRIES || 2);
    const baseTimeout = Number(process.env.FETCH_TIMEOUT_MS || 6000); // ms
    let lastErr = null;
    let response = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetchWithTimeout(url, {
          method,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: "application/json",
            "User-Agent": process.env.USER_AGENT || "clash-proxy/1.0",
          },
          body: body ? JSON.stringify(body) : undefined,
        }, baseTimeout * attempt); // increase timeout slightly per attempt
        break;
      } catch (err) {
        lastErr = err;
        const backoff = Math.min(2000, 200 * Math.pow(2, attempt)); // capped backoff
        await new Promise(r => setTimeout(r, backoff));
      }
    }

    if (!response) {
      throw lastErr || new Error("No response from fetch attempts");
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (shouldCache) {
      await setCache(cacheKey, { status: response.status, body: parsed }, CACHE_TTL);
    }

    return res.status(response.status).json(parsed);
  } catch (err) {
    console.error("cocFetch error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// ---------- Simple validators ----------
function isValidSafePath(p) {
  // allow only basic path characters to avoid injections
  return /^[\w\-\/%\.]+$/.test(p);
}

// ---------- Routes (same endpoints as before) ----------

// Root and health
app.get("/", (req, res) => res.send("✅ Clash of Clans API Proxy is running!"));
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), redis: !!redis }));
app.get("/ready", (req, res) => res.json({ ready: true }));

// Search
app.get("/search/clans", (req, res) => {
  const qsAllowed = ["name", "limit", "after", "before", "locationId", "minMembers", "maxMembers", "warFrequency", "minClanPoints", "labelIds"];
  return cocFetch(`/clans`, req, res, { cacheKey: `search:clans:${req.originalUrl}`, allowedQueryParams: qsAllowed });
});

app.get("/search/players", (req, res) => {
  const qsAllowed = ["name", "limit", "after", "before", "locationId"];
  return cocFetch(`/players`, req, res, { cacheKey: `search:players:${req.originalUrl}`, allowedQueryParams: qsAllowed });
});

// Clans
app.get("/clan/:tag", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}`, req, res, { cacheKey: `clan:${tag}` });
});
app.get("/clan/:tag/members", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/members`, req, res, { cacheKey: `clan:${tag}:members` });
});
app.get("/clan/:tag/warlog", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/warlog`, req, res, { cacheKey: `clan:${tag}:warlog` });
});
app.get("/clan/:tag/currentwar", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/currentwar`, req, res, { cacheKey: `clan:${tag}:currentwar` });
});
app.get("/clan/:tag/currentwar/leaguegroup", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/currentwar/leaguegroup`, req, res, { cacheKey: `clan:${tag}:leaguegroup` });
});
app.get("/clan/:tag/currentwar/rounds", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/currentwar/rounds`, req, res, { cacheKey: `clan:${tag}:rounds` });
});

// Clan capital
app.get("/clan/:tag/capital", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/capital`, req, res, { cacheKey: `clan:${tag}:capital` });
});
app.get("/clan/:tag/capital/districts", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/capital/districts`, req, res, { cacheKey: `clan:${tag}:capital:districts` });
});
app.get("/clan/:tag/capital/raidseason", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/capital/raidseason`, req, res, { cacheKey: `clan:${tag}:capital:raidseason` });
});

// Players
app.get("/player/:tag", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/players/${tag}`, req, res, { cacheKey: `player:${tag}` });
});
app.get("/player/:tag/battlelog", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/players/${tag}/battlelog`, req, res, { cacheKey: `player:${tag}:battlelog` });
});
app.post("/player/:tag/verifytoken", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/players/${tag}/verifytoken`, req, res, { method: "POST", body: req.body });
});

// Leagues & warleagues
app.get("/leagues", (req, res) => cocFetch(`/leagues`, req, res, { cacheKey: `leagues` }));
app.get("/leagues/:leagueId", (req, res) => cocFetch(`/leagues/${req.params.leagueId}`, req, res, { cacheKey: `league:${req.params.leagueId}` }));
app.get("/leagues/:leagueId/seasons", (req, res) => cocFetch(`/leagues/${req.params.leagueId}/seasons`, req, res, { cacheKey: `league:${req.params.leagueId}:seasons` }));
app.get("/leagues/:leagueId/seasons/:seasonId", (req, res) => cocFetch(`/leagues/${req.params.leagueId}/seasons/${req.params.seasonId}`, req, res, { cacheKey: `league:${req.params.leagueId}:season:${req.params.seasonId}` }));

app.get("/warleagues", (req, res) => cocFetch(`/warleagues`, req, res, { cacheKey: `warleagues` }));
app.get("/warleagues/:leagueId", (req, res) => cocFetch(`/warleagues/${req.params.leagueId}`, req, res, { cacheKey: `warleague:${req.params.leagueId}` }));

// war by tag (league war)
app.get("/wars/:warTag", (req, res) => {
  const tag = encodeTag(req.params.warTag);
  return cocFetch(`/clanwarleagues/wars/${tag}`, req, res, { cacheKey: `war:${tag}` });
});

// Locations & rankings
app.get("/locations", (req, res) => cocFetch(`/locations`, req, res, { cacheKey: `locations` }));
app.get("/locations/:locationId", (req, res) => cocFetch(`/locations/${req.params.locationId}`, req, res, { cacheKey: `location:${req.params.locationId}` }));
app.get("/locations/:locationId/rankings/clans", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/clans`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:clans`, allowedQueryParams: ["limit","after","before"] }));
app.get("/locations/:locationId/rankings/players", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/players`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:players`, allowedQueryParams: ["limit","after","before"] }));
app.get("/locations/:locationId/rankings/clans-versus", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/clans-versus`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:clans-versus`, allowedQueryParams: ["limit","after","before"] }));
app.get("/locations/:locationId/rankings/players-versus", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/players-versus`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:players-versus`, allowedQueryParams: ["limit","after","before"] }));

// Labels & goldpass
app.get("/labels/clans", (req, res) => cocFetch(`/labels/clans`, req, res, { cacheKey: `labels:clans` }));
app.get("/labels/players", (req, res) => cocFetch(`/labels/players`, req, res, { cacheKey: `labels:players` }));
app.get("/goldpass/current", (req, res) => cocFetch(`/goldpass/seasons/current`, req, res, { cacheKey: `goldpass:current` }));

// Generic raw proxy but controlled by whitelist
const RAW_WHITELIST = (process.env.RAW_WHITELIST || "/locations,/leagues,/labels").split(",").map(s => s.trim()).filter(Boolean);
app.get("/raw/*", (req, res) => {
  const rawPath = req.path.replace(/^\/raw/, "");
  if (!isValidSafePath(rawPath)) return res.status(400).json({ error: "Invalid path" });

  if (RAW_WHITELIST.length > 0) {
    const allowed = RAW_WHITELIST.some(prefix => rawPath.startsWith(prefix));
    if (!allowed) return res.status(403).json({ error: "raw proxy not allowed for this path (whitelist)" });
  }

  return cocFetch(rawPath, req, res, { cacheKey: `raw:${rawPath}:${req.originalUrl}` });
});

// 404 and error handler
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: err.message || "Internal Server Error" });
});

// ---------- Start server with graceful shutdown ----------
const server = app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));

async function shutdown(signal) {
  console.log(`Received ${signal} — shutting down gracefully...`);
  server.close(async () => {
    console.log("HTTP server closed");
    if (redis) {
      try {
        await redis.quit();
        console.log("Redis connection closed");
      } catch (e) {
        console.error("Error closing Redis:", e);
      }
    }
    process.exit(0);
  });

  // force exit after timeout
  setTimeout(() => {
    console.error("Could not close in time, forcing shutdown");
    process.exit(1);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10_000));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
