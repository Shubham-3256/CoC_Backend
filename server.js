// server.js
import express from "express";
import dotenv from "dotenv";
import morgan from "morgan";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const COC_API = "https://api.clashofclans.com/v1";
const TOKEN = process.env.COC_TOKEN;

if (!TOKEN) {
  console.error("❌ Missing COC_TOKEN environment variable. Create a token at developer.clashofclans.com and set COC_TOKEN.");
  process.exit(1);
}

// Use global fetch on Node 18+, otherwise fallback to node-fetch
const fetchFn = global.fetch || (await import("node-fetch")).default;

// Basic middleware
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(morgan("combined"));

// CORS (open by default for dev)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten in production
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Rate limiter (basic)
const limiter = rateLimit({
  windowMs: 15 * 1000, // 15s window
  max: 100, // max requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Simple in-memory cache for GET responses
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 30); // default 30s
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: CACHE_TTL * 0.2 });

// Utility: normalize/encode a clan/player tag
function encodeTag(raw) {
  if (!raw) return "";
  // if already encoded or starts with %23
  if (raw.startsWith("%23")) return raw;
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  return encodeURIComponent(withHash); // '#ABC' -> '%23ABC'
}

// Utility: build query string from allowed params
function qsFrom(req, allowed = []) {
  const params = new URLSearchParams();
  for (const k of allowed) {
    if (req.query[k] !== undefined) params.append(k, req.query[k]);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// Fetch wrapper with retries, caching for GETs, and faithful forwarding of status/body
async function cocFetch(path, req, res, { method = "GET", body = null, cacheKey = null, allowedQueryParams = [] } = {}) {
  try {
    const qs = qsFrom(req, allowedQueryParams);
    const url = `${COC_API}${path}${qs}`;

    // Only cache GETs and when cacheKey provided
    const shouldCache = method === "GET" && cacheKey;
    if (shouldCache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return res.status(cached.status).json(cached.body);
      }
    }

    // perform fetch + simple retry (2 attempts)
    let lastErr = null;
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetchFn(url, {
          method,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        break;
      } catch (err) {
        lastErr = err;
        // small backoff
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!response) throw lastErr || new Error("No response from fetch");

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    // Optionally cache
    if (shouldCache) {
      cache.set(cacheKey, { status: response.status, body: parsed });
    }

    // Forward status & body exactly
    return res.status(response.status).json(parsed);
  } catch (err) {
    console.error("cocFetch error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

/* ---------------------------
   ROUTES - comprehensive set
   --------------------------- */

/* --- Root --- */
app.get("/", (req, res) => res.send("✅ Clash of Clans API Proxy is running!"));

/* --- Search endpoints --- */
/* Search clans: /clans?name=foo&limit=10&loc=LOCATIONID */
app.get("/search/clans", (req, res) => {
  // pass through query params the API accepts: name, limit, after, before, locationId, minMembers, maxMembers, warFrequency, minClanPoints, labelIds
  const qsAllowed = ["name", "limit", "after", "before", "locationId", "minMembers", "maxMembers", "warFrequency", "minClanPoints", "labelIds"];
  return cocFetch(`/clans`, req, res, { cacheKey: `search:clans:${req.originalUrl}`, allowedQueryParams: qsAllowed });
});

/* Search players: /search/players?name=foo&limit=10 */
app.get("/search/players", (req, res) => {
  const qsAllowed = ["name", "limit", "after", "before", "locationId"];
  return cocFetch(`/players`, req, res, { cacheKey: `search:players:${req.originalUrl}`, allowedQueryParams: qsAllowed });
});

/* --- Clans --- */
// clan basic info
app.get("/clan/:tag", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}`, req, res, { cacheKey: `clan:${tag}` });
});

// members
app.get("/clan/:tag/members", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/members`, req, res, { cacheKey: `clan:${tag}:members` });
});

// war log (public war log)
app.get("/clan/:tag/warlog", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/warlog`, req, res, { cacheKey: `clan:${tag}:warlog` });
});

// current war
app.get("/clan/:tag/currentwar", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/currentwar`, req, res, { cacheKey: `clan:${tag}:currentwar` });
});

// current war league group (CWL group information, if applicable)
app.get("/clan/:tag/currentwar/leaguegroup", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/currentwar/leaguegroup`, req, res, { cacheKey: `clan:${tag}:leaguegroup` });
});

// currentwar rounds (if returned by above; keep for convenience)
app.get("/clan/:tag/currentwar/rounds", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/clans/${tag}/currentwar/rounds`, req, res, { cacheKey: `clan:${tag}:rounds` });
});

// clan capital endpoints
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

// clan labels (list & clan labels are already below as top-level labels endpoints)
/* --- Players --- */
app.get("/player/:tag", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/players/${tag}`, req, res, { cacheKey: `player:${tag}` });
});

// player battle log
app.get("/player/:tag/battlelog", (req, res) => {
  const tag = encodeTag(req.params.tag);
  return cocFetch(`/players/${tag}/battlelog`, req, res, { cacheKey: `player:${tag}:battlelog` });
});

// verify token (one-time token provided by a player from their client)
// POST /player/:tag/verifytoken  with { "token": "xxxxx" } in body
app.post("/player/:tag/verifytoken", (req, res) => {
  const tag = encodeTag(req.params.tag);
  // body is passed through
  return cocFetch(`/players/${tag}/verifytoken`, req, res, { method: "POST", body: req.body });
});

/* --- Leagues & Warleagues --- */
// leagues list
app.get("/leagues", (req, res) => cocFetch(`/leagues`, req, res, { cacheKey: `leagues` }));
app.get("/leagues/:leagueId", (req, res) => cocFetch(`/leagues/${req.params.leagueId}`, req, res, { cacheKey: `league:${req.params.leagueId}` }));

// league seasons
app.get("/leagues/:leagueId/seasons", (req, res) => cocFetch(`/leagues/${req.params.leagueId}/seasons`, req, res, { cacheKey: `league:${req.params.leagueId}:seasons` }));
app.get("/leagues/:leagueId/seasons/:seasonId", (req, res) => cocFetch(`/leagues/${req.params.leagueId}/seasons/${req.params.seasonId}`, req, res, { cacheKey: `league:${req.params.leagueId}:season:${req.params.seasonId}` }));

// war leagues (CWL) top-level
app.get("/warleagues", (req, res) => cocFetch(`/warleagues`, req, res, { cacheKey: `warleagues` }));
app.get("/warleagues/:leagueId", (req, res) => cocFetch(`/warleagues/${req.params.leagueId}`, req, res, { cacheKey: `warleague:${req.params.leagueId}` }));

// If you have a war tag from a league/group, you can fetch war details by warTag:
app.get("/wars/:warTag", (req, res) => {
  // warTag is supplied raw (e.g. #WAR_TAG) - we accept either encoded or raw
  const tag = encodeTag(req.params.warTag);
  return cocFetch(`/clanwarleagues/wars/${tag}`, req, res, { cacheKey: `war:${tag}` });
});

/* --- Locations & Rankings --- */
app.get("/locations", (req, res) => cocFetch(`/locations`, req, res, { cacheKey: `locations` }));
app.get("/locations/:locationId", (req, res) => cocFetch(`/locations/${req.params.locationId}`, req, res, { cacheKey: `location:${req.params.locationId}` }));

// rankings (clans / players). allowed query params: limit, after, before, period?
app.get("/locations/:locationId/rankings/clans", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/clans`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:clans`, allowedQueryParams: ["limit","after","before"] }));
app.get("/locations/:locationId/rankings/players", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/players`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:players`, allowedQueryParams: ["limit","after","before"] }));
app.get("/locations/:locationId/rankings/clans-versus", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/clans-versus`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:clans-versus`, allowedQueryParams: ["limit","after","before"] }));
app.get("/locations/:locationId/rankings/players-versus", (req, res) => cocFetch(`/locations/${req.params.locationId}/rankings/players-versus`, req, res, { cacheKey: `location:${req.params.locationId}:rankings:players-versus`, allowedQueryParams: ["limit","after","before"] }));

/* --- Labels --- */
app.get("/labels/clans", (req, res) => cocFetch(`/labels/clans`, req, res, { cacheKey: `labels:clans` }));
app.get("/labels/players", (req, res) => cocFetch(`/labels/players`, req, res, { cacheKey: `labels:players` }));

/* --- Gold Pass --- */
app.get("/goldpass/current", (req, res) => cocFetch(`/goldpass/seasons/current`, req, res, { cacheKey: `goldpass:current` }));

/* --- Game Data (optional endpoints developers sometimes use) --- */
// If you want to add static game data endpoints (if public API exposes them), create similar proxies.
// e.g. /gameconstants, /items, etc. (Not enabled by default here)

/* --- Generic proxy: allow requesting any path under v1 (careful in prod) --- */
app.get("/raw/*", (req, res) => {
  // only allow read-only, forward path after /raw
  const rawPath = req.path.replace(/^\/raw/, "");
  // Basic sanitization: only allow ascii, digits, hyphen, slash, underscore, percent, question & ampersand
  if (!/^[\w\-\/%\.]+$/.test(rawPath)) return res.status(400).json({ error: "Invalid path" });
  return cocFetch(rawPath, req, res, { cacheKey: `raw:${rawPath}:${req.originalUrl}` });
});

/* --- 404 --- */
app.use((req, res) => res.status(404).json({ error: "Not found" }));

/* --- Error handler --- */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: err.message || "Internal Server Error" });
});

/* --- Start --- */
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
