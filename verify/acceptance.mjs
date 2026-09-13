#!/usr/bin/env node
// Independent acceptance probe against the REAL running stack
// (http://api:8080). It recomputes the Magnus formula itself, then asserts
// the service returns the same numbers and the correct verdict. A fake or
// fixed-result API cannot pass these checks.

const BASE = process.env.ASSERT_API_ORIGIN || 'http://api:8080'
const A = 17.62
const B = 243.12

function expect(cond, message) {
  if (!cond) {
    console.error(`✗ ${message}`)
    process.exitCode = 1
    throw new Error(message)
  }
  console.log(`✓ ${message}`)
}

function round2(v) {
  return Math.round(v * 100) / 100
}

async function post(body) {
  const res = await fetch(`${BASE}/api/assessments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function main() {
  // 1. Health.
  const h = await fetch(`${BASE}/api/healthz`).then((r) => r.json())
  expect(h.status === 'ok', 'healthz reports ok')

  // 2. Known sample, independent recomputation.
  const sample = { voyage: 'ACCEPT-1', hatch: '3H', tg: 25, ta: 20, rh: 70 }
  const { status, body } = await post(sample)
  expect(status === 201, `valid sample is 201 (got ${status})`)

  const gamma = Math.log(sample.rh / 100) + (A * sample.ta) / (B + sample.ta)
  const td = (B * gamma) / (A - gamma)
  const delta = sample.tg - td
  expect(Math.abs(body.gamma - gamma) < 1e-12, `γ matches: api=${body.gamma} expected=${gamma}`)
  expect(Math.abs(body.td - td) < 1e-12, `Td matches: api=${body.td} expected=${td}`)
  expect(Math.abs(body.delta - delta) < 1e-12, `unrounded Δ matches: ${delta}`)
  expect(body.td_display === round2(td), `Td display rounds to 2 dp: ${body.td_display}`)
  expect(body.delta_display === round2(delta), `Δ display rounds to 2 dp: ${body.delta_display}`)
  expect(body.verdict === 'allowed', 'Δ ≈ 10.64 -> allowed')

  // 3. Reload consistency: GET detail and GET list must return the same
  // verdict and unrounded values as the POST response.
  const detail = await fetch(`${BASE}/api/assessments/${body.id}`).then((r) => r.json())
  expect(detail.verdict === body.verdict && detail.delta === body.delta,
    'detail after reload keeps the same verdict and Δ')
  const list = await fetch(`${BASE}/api/assessments`).then((r) => r.json())
  const listed = list.items.find((i) => i.id === body.id)
  expect(!!listed && listed.verdict === body.verdict,
    'list after reload keeps the same verdict')
  expect(typeof detail.formula.delta_line === 'string' &&
    detail.formula.delta_line.includes('Δ = Tg − Td'),
    'detail page exposes the substituted formula lines')

  // 4. Denied and retest zones.
  const denied = await post({ voyage: 'ACCEPT-2', hatch: '1P', tg: 5, ta: 28, rh: 95 })
  expect(denied.status === 201 && denied.body.verdict === 'denied',
    `cold grain / humid air -> denied (got ${denied.body?.verdict})`)

  const retest = await post({ voyage: 'ACCEPT-3', hatch: '2S', tg: 16.357, ta: 20, rh: 70 })
  expect(retest.status === 201 && retest.body.verdict === 'retest'
    && retest.body.delta_display === 2.00,
    `Δ displays 2.00 but is < 2 unrounded -> retest (got ${retest.body?.verdict}/${retest.body?.delta_display})`)
  const retestNeg = await post({ voyage: 'ACCEPT-4', hatch: '2S', tg: 12.36, ta: 20, rh: 70 })
  expect(retestNeg.status === 201 && retestNeg.body.verdict === 'retest'
    && retestNeg.body.delta_display === -2.00,
    `Δ displays -2.00 but is > -2 unrounded -> retest (got ${retestNeg.body?.verdict}/${retestNeg.body?.delta_display})`)

  // 5. Construct BOTH exact mathematical endpoints Δ = Td ± 2 against the
  // unrounded Td returned by the service. Floating-point addition may land
  // one ULP outside, so search the nearest Tg values: in both directions the
  // verdict must be retest at the inclusive endpoint and only change beyond.
  for (const dir of [1, -1]) {
    let tg = td + dir * 2
    const wanted = dir > 0 ? 'allowed' : 'denied'
    // Nudge inward until retest appears (the inclusive endpoint).
    for (let n = 0; n < 8; n++) {
      const r = await post({ voyage: `EDGE-${dir}-${n}`, hatch: 'H', tg, ta: 20, rh: 70 })
      if (r.body.verdict === 'retest') {
        expect(round2(r.body.delta) === dir * 2,
          `endpoint Δ=${dir * 2}.00 is retest (raw Δ=${r.body.delta})`)
        // One tiny step outward must already decide strictly.
        const step = 2e-12 * dir
        const out = await post({ voyage: `EDGE-OUT-${dir}-${n}`, hatch: 'H', tg: tg + step, ta: 20, rh: 70 })
        expect(out.body.verdict === wanted,
          `one ULP-scale step beyond Δ=${dir * 2}.00 -> ${wanted}`)
        break
      }
      tg -= dir * 5e-13
      if (n === 7) expect(false, `never found retest at endpoint dir=${dir}`)
    }
  }

  // 6. Invalid input -> 422 with field errors and NO new record.
  const before = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items.length
  const cases = [
    { body: { voyage: 'BAD', hatch: 'H', tg: 60.5, ta: 20, rh: 70 }, field: 'tg' },
    { body: { voyage: 'BAD', hatch: 'H', tg: 20, ta: -20.01, rh: 70 }, field: 'ta' },
    { body: { voyage: 'BAD', hatch: 'H', tg: 20, ta: 20, rh: 0.99 }, field: 'rh' },
    { raw: '{"voyage":"BAD","hatch":"H","tg":1e999,"ta":20,"rh":70}', field: 'tg' },
    { body: { voyage: 'BAD', hatch: 'H', tg: -21, ta: 200, rh: 0 }, fields: 3 },
  ]
  for (const c of cases) {
    const r = c.raw ? await post(c.raw) : await post(c.body)
    expect(r.status === 422, `422 for rejected input (${c.field || c.fields})`)
    if (c.field) {
      expect(r.body.fields.some((f) => f.field === c.field), `field error names ${c.field}`)
    } else {
      expect(r.body.fields.length === c.fields, `all ${c.fields} bad fields reported`)
    }
  }
  const after = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items.length
  expect(after === before, `no record persisted on 422 (${before} before, ${after} after)`)

  console.log('\nALL ACCEPTANCE CHECKS PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
