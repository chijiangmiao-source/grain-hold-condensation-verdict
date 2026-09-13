// Thin client for the Gin API. The browser NEVER computes the dew point or
// verdict itself: every gamma/Td/delta/verdict value rendered on screen
// comes from these responses, so page and API share one calculation.
//
// Requests are same-origin (nginx proxies /api to Gin in Docker, and Vite's
// dev proxy does the same locally). Building an absolute URL from the
// document origin keeps the calls working under jsdom too.
const ORIGIN = typeof window !== 'undefined' && window.location
  ? window.location.origin
  : 'http://localhost'
const BASE = `${ORIGIN}/api`

async function parse(res) {
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  return { ok: res.ok, status: res.status, data }
}

export function listAssessments() {
  return fetch(`${BASE}/assessments`).then(parse)
}

export function getAssessment(id) {
  return fetch(`${BASE}/assessments/${encodeURIComponent(id)}`).then(parse)
}

export async function createAssessment(payload) {
  const res = await fetch(`${BASE}/assessments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return parse(res)
}
