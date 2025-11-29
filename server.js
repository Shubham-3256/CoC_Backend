// server.js
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')

const app = express()

// ==== Config ====
const PORT = process.env.PORT || 3000
const COC_API = process.env.COC_API_BASE || 'https://api.clashofclans.com/v1'
const TOKEN = process.env.COC_API_TOKEN
const CACHE_TTL = Number(process.env.CACHE_TTL || 30) * 1000 // ms
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 6000)

if (!TOKEN) {
  console.warn('⚠️  COC_API_TOKEN not set! Set it in .env')
}

// ==== Basic middleware ====
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(
  morgan('dev', {
    skip: (req) => req.path === '/health',
  })
)

// attach requestId for easier debugging (very simple)
app.use((req, res, next) => {
  req.requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  next()
})

// ==== Simple in-memory cache ====
const cacheStore = new Map()

function cacheGet(key) {
  const entry = cacheStore.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key)
    return null
  }
  return entry.value
}

function cacheSet(key, value, ttlMs = CACHE_TTL) {
  cacheStore.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  })
}

// ==== Helpers ====

/**
 * Encode clan/player tag for CoC API.
 * Accepts:
 *  - "#TAG"
 *  - "TAG"
 *  - "%23TAG" (Express decodes this to "#TAG" already)
 */
function encodeTag(raw) {
  if (!raw) return ''
  let tag = raw.trim().toUpperCase()
  if (!tag.startsWith('#')) tag = `#${tag}`
  return encodeURIComponent(tag)
}

/**
 * Validate a tag param.
 */
function validateTagParam(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'tag_missing' }
  }
  const trimmed = raw.trim()
  if (!trimmed.length) {
    return { ok: false, reason: 'tag_empty' }
  }
  return { ok: true }
}

/**
 * Async wrapper to forward errors to Express error handler.
 */
function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/**
 * Fetch with timeout using built-in fetch (Node 18+).
 */
async function fetchWithTimeout(resource, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)

  try {
    const resp = await fetch(resource, { ...options, signal: controller.signal })
    return resp
  } finally {
    clearTimeout(id)
  }
}

/**
 * Safe JSON parse that keeps the raw body if parsing fails.
 */
function safeJsonParse(text) {
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch {
    return { ok: false, raw: text }
  }
}

/**
 * Direct proxy to Clash of Clans API that writes directly to res.
 * Use this for simple pass-through endpoints.
 */
async function cocFetch(path, req, res, { cacheKey = null, method = 'GET', body = null } = {}) {
  try {
    // GET cache
    if (cacheKey && method === 'GET') {
      const cached = cacheGet(cacheKey)
      if (cached) {
        return res.json(cached)
      }
    }

    const url = `${COC_API}${path}`

    const resp = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/json',
          'User-Agent': process.env.USER_AGENT || 'coc-dashboard-proxy/1.0',
          'Content-Type': body ? 'application/json' : undefined,
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      FETCH_TIMEOUT_MS
    )

    const text = await resp.text()
    const parsed = safeJsonParse(text)
    const payload = parsed.ok ? parsed.json : { raw: parsed.raw }

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: 'upstream_error',
        status: resp.status,
        message: payload?.reason || payload?.message || 'Error from Clash of Clans API',
        upstream: payload,
        requestId: req.requestId,
      })
    }

    // write to cache
    if (cacheKey && method === 'GET') {
      cacheSet(cacheKey, payload)
    }

    return res.json(payload)
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : 500
    return res.status(status).json({
      error: 'proxy_error',
      message: err.message || 'Failed to contact Clash of Clans API',
      requestId: req.requestId,
    })
  }
}

/**
 * JSON fetch from CoC API that returns data (used for aggregated endpoints).
 */
async function cocGetJson(path, { cacheKey = null, method = 'GET', body = null } = {}) {
  // GET cache
  if (cacheKey && method === 'GET') {
    const cached = cacheGet(cacheKey)
    if (cached) return cached
  }

  const url = `${COC_API}${path}`

  const resp = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
        'User-Agent': process.env.USER_AGENT || 'coc-dashboard-proxy/1.0',
        'Content-Type': body ? 'application/json' : undefined,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    FETCH_TIMEOUT_MS
  )

  const text = await resp.text()
  const parsed = safeJsonParse(text)
  const payload = parsed.ok ? parsed.json : { raw: parsed.raw }

  if (!resp.ok) {
    const err = new Error(payload?.reason || payload?.message || `Upstream error ${resp.status}`)
    err.status = resp.status
    err.upstream = payload
    throw err
  }

  if (cacheKey && method === 'GET') {
    cacheSet(cacheKey, payload)
  }

  return payload
}

// ==== Health & meta ====

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), requestId: req.requestId })
})

// ==== Core Clash of Clans proxy endpoints ====

// Search clans
// GET /search/clans?name=...&limit=...
app.get(
  '/search/clans',
  wrap(async (req, res) => {
    const params = new URLSearchParams()
    if (req.query.name) params.set('name', req.query.name)
    if (req.query.limit) params.set('limit', req.query.limit)

    const path = `/clans?${params.toString()}`
    return cocFetch(path, req, res, {
      cacheKey: `search:clans:${params.toString()}`,
    })
  })
)

// GET /clan/:tag
app.get(
  '/clan/:tag',
  wrap(async (req, res) => {
    const v = validateTagParam(req.params.tag)
    if (!v.ok) {
      return res.status(400).json({
        error: 'invalid_tag',
        reason: v.reason,
        requestId: req.requestId,
      })
    }

    const tag = encodeTag(req.params.tag)
    return cocFetch(`/clans/${tag}`, req, res, {
      cacheKey: `clan:${tag}`,
    })
  })
)

// GET /clan/:tag/members
app.get(
  '/clan/:tag/members',
  wrap(async (req, res) => {
    const v = validateTagParam(req.params.tag)
    if (!v.ok) {
      return res.status(400).json({
        error: 'invalid_tag',
        reason: v.reason,
        requestId: req.requestId,
      })
    }

    const tag = encodeTag(req.params.tag)
    return cocFetch(`/clans/${tag}/members`, req, res, {
      cacheKey: `clan:${tag}:members`,
    })
  })
)

// GET /clan/:tag/warlog
app.get(
  '/clan/:tag/warlog',
  wrap(async (req, res) => {
    const v = validateTagParam(req.params.tag)
    if (!v.ok) {
      return res.status(400).json({
        error: 'invalid_tag',
        reason: v.reason,
        requestId: req.requestId,
      })
    }

    const tag = encodeTag(req.params.tag)
    return cocFetch(`/clans/${tag}/warlog`, req, res, {
      cacheKey: `clan:${tag}:warlog`,
    })
  })
)

// GET /clan/:tag/currentwar
app.get(
  '/clan/:tag/currentwar',
  wrap(async (req, res) => {
    const v = validateTagParam(req.params.tag)
    if (!v.ok) {
      return res.status(400).json({
        error: 'invalid_tag',
        reason: v.reason,
        requestId: req.requestId,
      })
    }

    const tag = encodeTag(req.params.tag)
    return cocFetch(`/clans/${tag}/currentwar`, req, res, {
      cacheKey: `clan:${tag}:currentwar`,
    })
  })
)

// GET /player/:tag
app.get(
  '/player/:tag',
  wrap(async (req, res) => {
    const v = validateTagParam(req.params.tag)
    if (!v.ok) {
      return res.status(400).json({
        error: 'invalid_tag',
        reason: v.reason,
        requestId: req.requestId,
      })
    }

    const tag = encodeTag(req.params.tag)
    return cocFetch(`/players/${tag}`, req, res, {
      cacheKey: `player:${tag}`,
    })
  })
)

// NOTE: ❌ NO /player/:tag/battlelog here, because CoC API does not support it.

// ==== Aggregated endpoints (custom) ====

// GET /clan/:tag/stats
app.get(
  '/clan/:tag/stats',
  wrap(async (req, res) => {
    const rawTag = req.params.tag
    const v = validateTagParam(rawTag)
    if (!v.ok) {
      return res.status(400).json({
        error: 'invalid_tag',
        reason: v.reason,
        requestId: req.requestId,
      })
    }

    const tag = encodeTag(rawTag)

    // Fetch clan + members
    const clan = await cocGetJson(`/clans/${tag}`, {
      cacheKey: `clan:${tag}:info`,
    })

    const membersPayload = await cocGetJson(`/clans/${tag}/members`, {
      cacheKey: `clan:${tag}:members`,
    })

    const members = membersPayload.items || []
    const totalMembers = members.length

    const totalTrophies = members.reduce((sum, m) => sum + (m.trophies || 0), 0)
    const avgTrophies = totalMembers > 0 ? Math.round(totalTrophies / totalMembers) : 0
    const highest = totalMembers > 0 ? Math.max(...members.map((m) => m.trophies || 0)) : 0
    const lowest = totalMembers > 0 ? Math.min(...members.map((m) => m.trophies || 0)) : 0

    const brackets = [
      { name: '3000+', min: 3000, count: 0 },
      { name: '2500-2999', min: 2500, max: 2999, count: 0 },
      { name: '2000-2499', min: 2000, max: 2499, count: 0 },
      { name: '1500-1999', min: 1500, max: 1999, count: 0 },
      { name: '1000-1499', min: 1000, max: 1499, count: 0 },
      { name: '<1000', min: 0, max: 999, count: 0 },
    ]

    members.forEach((m) => {
      const t = m.trophies || 0
      if (t >= 3000) brackets[0].count++
      else if (t >= 2500) brackets[1].count++
      else if (t >= 2000) brackets[2].count++
      else if (t >= 1500) brackets[3].count++
      else if (t >= 1000) brackets[4].count++
      else brackets[5].count++
    })

    return res.json({
      clan: {
        tag: clan.tag,
        name: clan.name,
        level: clan.clanLevel,
        points: clan.clanPoints,
        warWins: clan.warWins,
      },
      totalMembers,
      avgTrophies,
      highest,
      lowest,
      trophyDistribution: brackets,
      requestId: req.requestId,
    })
  })
)

// GET /clan/:tag/donations
app.get(
  '/clan/:tag/donations',
  wrap(async (req, res) => {
    const rawTag = req.params.tag
    const v = validateTagParam(rawTag)
    if (!v.ok) {
      return res.status(400).json({
        error: 'invalid_tag',
        reason: v.reason,
        requestId: req.requestId,
      })
    }

    const tag = encodeTag(rawTag)

    const membersPayload = await cocGetJson(`/clans/${tag}/members`, {
      cacheKey: `clan:${tag}:members`,
    })

    const members = membersPayload.items || []

    const perMember = members.map((m) => ({
      tag: m.tag,
      name: m.name,
      role: m.role,
      donations: m.donations || 0,
      donationsReceived: m.donationsReceived || 0,
    }))

    const totalDonations = perMember.reduce((sum, m) => sum + m.donations, 0)
    const totalReceived = perMember.reduce((sum, m) => sum + m.donationsReceived, 0)

    perMember.sort((a, b) => b.donations - a.donations)

    return res.json({
      totalDonations,
      totalReceived,
      members: perMember,
      requestId: req.requestId,
    })
  })
)

// ==== Optional raw proxy (debug) ====
// Enable with ALLOW_RAW_PROXY=true
if (process.env.ALLOW_RAW_PROXY === 'true') {
  app.get(
    '/raw/*',
    wrap(async (req, res) => {
      const path = req.params[0]
      const urlPart = path.startsWith('/') ? path : `/${path}`
      return cocFetch(urlPart, req, res, { cacheKey: `raw:${urlPart}` })
    })
  )
}

// ==== Error handler ====
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  const status = err.status || 500
  res.status(status).json({
    error: 'internal_error',
    message: err.message || 'Unexpected server error',
    requestId: req.requestId,
  })
})

// ==== Start server ====
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`)
})
