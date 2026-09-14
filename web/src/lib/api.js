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

// Read-only voyage overview: one latest snapshot per hatch, chosen by the
// server with MAX(id) per hatch. The browser receives the already-grouped
// items and only renders them; it never derives "latest" client-side.
export function getVoyageOverview(voyage) {
  return fetch(`${BASE}/voyages/${encodeURIComponent(voyage)}/hatches/latest`)
    .then(parse)
}

export async function createAssessment(payload) {
  const res = await fetch(`${BASE}/assessments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return parse(res)
}

// Batch entry: one ordered array of up to 20 measurements, saved by the
// server in a single transaction. On 422 the body is
// { error, rows: [{ row, fields: [...] }] } where row is 1-based; the page
// keeps every input and highlights the offending rows. The browser only
// renders the returned ids/deltas/verdicts, never computing them itself.
export async function createBatchAssessments(measurements) {
  const res = await fetch(`${BASE}/assessments/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ measurements }),
  })
  return parse(res)
}

// Robustness check: the browser only supplies three SYMMETRIC instrument
// error magnitudes for an existing assessment. The server generates the
// eight +/- boundary combinations, runs each through the existing
// unrounded dew-point decision, and freezes the results into one immutable
// check record. The browser never builds a boundary combination or verdict.
export async function createRobustnessCheck(assessmentId, tolerances) {
  const res = await fetch(
    `${BASE}/assessments/${encodeURIComponent(assessmentId)}/robustness-checks`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tolerances),
    },
  )
  return parse(res)
}

// Read-only: reopen an immutable robustness check by its own check number.
export function getRobustnessCheck(checkId) {
  return fetch(`${BASE}/robustness-checks/${encodeURIComponent(checkId)}`).then(parse)
}
