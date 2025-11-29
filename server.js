import dotenv from "dotenv"
dotenv.config()

import express from "express"
import cors from "cors"
import helmet from "helmet"
import morgan from "morgan"

// ==== Config ====
const app = express()

const PORT = process.env.PORT || 3000
const COC_API = process.env.COC_API_BASE || "https://api.clashofclans.com/v1"
const TOKEN = process.env.COC_API_TOKEN
const CACHE_TTL = Number(process.env.CACHE_TTL || 30) * 1000
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 6000)

if (!TOKEN) console.warn("⚠️ Missing COC_API_TOKEN in .env")

// ==== Middleware ====
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(morgan("dev"))

// Add requestId for debugging
app.use((req, res, next) => {
  req.requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  next()
})

// ==== Simple in-memory cache ====
const cache = new Map()

function cacheGet(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expire) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  cache.set(key, { value, expire: Date.now() + ttl })
}

// ==== Helpers ====
function validateTag(tag) {
  if (!tag) return { ok: false, reason: "missing_tag" }
  return { ok: true }
}

function encodeTag(rawTag) {
  if (!rawTag) return ''

  // Decode first so it works with "%23TAG" and "#TAG" and "TAG"
  let tag = decodeURIComponent(rawTag).trim().toUpperCase()

  if (!tag.startsWith('#')) tag = `#${tag}`

  return encodeURIComponent(tag)
}


function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)

  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

function parseJSON(text) {
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch {
    return { ok: false, raw: text }
  }
}

// ---- Proxy Fetch returning JSON (aggregate routes use this) ----
async function cocGetJson(path, { cacheKey = null, method = "GET", body = null } = {}) {
  if (cacheKey && method === "GET") {
    const c = cacheGet(cacheKey)
    if (c) return c
  }

  const resp = await fetchWithTimeout(
    `${COC_API}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
        "Content-Type": body ? "application/json" : undefined,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    FETCH_TIMEOUT_MS
  )

  const text = await resp.text()
  const parsed = parseJSON(text)
  const data = parsed.ok ? parsed.json : { raw: parsed.raw }

  if (!resp.ok) {
    const err = new Error(data?.message || `Error ${resp.status}`)
    err.status = resp.status
    throw err
  }

  if (cacheKey && method === "GET") cacheSet(cacheKey, data)
  return data
}

// ---- Proxy Fetch writing directly to res ----
async function cocFetch(path, req, res, { cacheKey = null }) {
  try {
    if (cacheKey) {
      const cached = cacheGet(cacheKey)
      if (cached) return res.json(cached)
    }

    const resp = await fetchWithTimeout(`${COC_API}${path}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
      },
    })

    const text = await resp.text()
    const parsed = parseJSON(text)
    const payload = parsed.ok ? parsed.json : { raw: parsed.raw }

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: "upstream_error",
        message: payload?.message || "Clash API error",
        requestId: req.requestId,
      })
    }

    if (cacheKey) cacheSet(cacheKey, payload)
    return res.json(payload)
  } catch (err) {
    return res.status(500).json({
      error: "proxy_error",
      message: err.message,
      requestId: req.requestId,
    })
  }
}

// =======================================
//              API ROUTES
// =======================================

// Health-check
app.get("/health", (req, res) => res.json({ ok: true, requestId: req.requestId }))

// ----- Direct CoC API Proxy Endpoints -----
app.get("/search/clans", wrap((req, res) => {
  const p = new URLSearchParams(req.query).toString()
  return cocFetch(`/clans?${p}`, req, res, { cacheKey: `search:${p}` })
}))

app.get("/clan/:tag", wrap((req, res) => {
  const { tag } = req.params
  const v = validateTag(tag)
  if (!v.ok) return res.status(400).json(v)

  return cocFetch(`/clans/${encodeTag(tag)}`, req, res, { cacheKey: `clan:${tag}` })
}))

app.get("/clan/:tag/members", wrap((req, res) => {
  const { tag } = req.params
  return cocFetch(`/clans/${encodeTag(tag)}/members`, req, res, {
    cacheKey: `clan:${tag}:members`,
  })
}))

app.get("/clan/:tag/warlog", wrap((req, res) => {
  const { tag } = req.params
  return cocFetch(`/clans/${encodeTag(tag)}/warlog`, req, res, {
    cacheKey: `clan:${tag}:warlog`,
  })
}))

app.get("/clan/:tag/currentwar", wrap((req, res) => {
  const { tag } = req.params
  return cocFetch(`/clans/${encodeTag(tag)}/currentwar`, req, res, {
    cacheKey: `clan:${tag}:currentwar`,
  })
}))

app.get("/player/:tag", wrap((req, res) => {
  return cocFetch(`/players/${encodeTag(req.params.tag)}`, req, res, {
    cacheKey: `player:${req.params.tag}`,
  })
}))

// NOTE ❌ NO /player/:tag/battlelog (not in official API)

// =======================================
//    CUSTOM AGGREGATED ENDPOINTS
// =======================================

// ----- Donation Aggregation -----
app.get("/clan/:tag/donations", wrap(async (req, res) => {
  const tag = encodeTag(req.params.tag)

  const members = await cocGetJson(`/clans/${tag}/members`, {
    cacheKey: `clan:${tag}:members`,
  })

  const list = (members.items || []).map(m => ({
    name: m.name,
    tag: m.tag,
    role: m.role,
    donations: m.donations || 0,
    received: m.donationsReceived || 0,
  }))

  const total = list.reduce((s, m) => s + m.donations, 0)

  return res.json({
    total,
    members: list.sort((a, b) => b.donations - a.donations),
    requestId: req.requestId,
  })
}))

// ----- Stats Aggregation -----
app.get("/clan/:tag/stats", wrap(async (req, res) => {
  const tag = encodeTag(req.params.tag)

  const clan = await cocGetJson(`/clans/${tag}`, { cacheKey: `clan:${tag}` })
  const members = await cocGetJson(`/clans/${tag}/members`, {
    cacheKey: `clan:${tag}:members`,
  })

  const list = members.items || []
  const count = list.length

  const totalTrophies = list.reduce((s, m) => s + (m.trophies || 0), 0)

  return res.json({
    clan: {
      tag: clan.tag,
      name: clan.name,
      level: clan.clanLevel,
    },
    totalMembers: count,
    avgTrophies: count ? Math.round(totalTrophies / count) : 0,
    highest: count ? Math.max(...list.map(m => m.trophies || 0)) : 0,
    lowest: count ? Math.min(...list.map(m => m.trophies || 0)) : 0,
    requestId: req.requestId,
  })
}))

// =======================================
//        ERROR HANDLER + START
// =======================================
app.use((err, req, res, next) => {
  console.error(err)
  res.status(err.status || 500).json({
    error: "server_error",
    message: err.message,
    requestId: req.requestId,
  })
})

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`))
