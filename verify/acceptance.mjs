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

// Batch submission helper. The ordered measurements array is saved in one
// transaction; 201 -> { count, items:[<single DTO>…] }, 422 -> { rows:[{row,
// fields}] } with 1-based row numbers.
async function postBatch(measurements) {
  const res = await fetch(`${BASE}/api/assessments/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ measurements }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// Robustness-check helpers. The browser supplies ONLY three symmetric error
// magnitudes; every boundary combination and verdict is computed by Go.
async function postCheck(assessmentId, tolerances) {
  const res = await fetch(`${BASE}/api/assessments/${assessmentId}/robustness-checks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof tolerances === 'string' ? tolerances : JSON.stringify(tolerances),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
async function getCheck(checkId) {
  const res = await fetch(`${BASE}/api/robustness-checks/${checkId}`)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// Independent band rule used ONLY by this probe to verify the server's
// per-corner verdicts (closed interval [-2, 2] -> retest).
function verdictFor(delta) {
  if (delta > 2) return 'allowed'
  if (delta < -2) return 'denied'
  return 'retest'
}

function magnus(m) {
  const gamma = Math.log(m.rh / 100) + (A * m.ta) / (B + m.ta)
  const td = (B * gamma) / (A - gamma)
  return { gamma, td, delta: m.tg - td }
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

  // 3b. Traceable predecessor comparison for consecutive measurements of
  // the same voyage+hatch. The probe independently computes the expected
  // unrounded changes; the browser/API must not be trusted to subtract.
  const chainVoyage = 'ACCEPT-CHAIN'
  const m1 = { voyage: chainVoyage, hatch: '5H', tg: 25.345, ta: 20.123, rh: 71.5 }
  const m2 = { voyage: chainVoyage, hatch: '5H', tg: 24.117, ta: 21.987, rh: 68.25 }
  const c1 = await post(m1)
  const c2 = await post(m2)
  expect(c1.status === 201 && c2.status === 201, 'chain submissions are 201')
  expect(c1.body.comparison === undefined, 'POST body never carries a comparison block')
  expect(c2.body.comparison === undefined, 'POST body never carries a comparison block')

  const d1 = await fetch(`${BASE}/api/assessments/${c1.body.id}`).then((r) => r.json())
  expect(d1.comparison === undefined, 'first measurement has no comparison on detail either')

  // An interleaved submission for a DIFFERENT hatch must not enter the chain.
  const interleaved = await post({ voyage: chainVoyage, hatch: '6H', tg: 30, ta: 20, rh: 70 })
  expect(interleaved.status === 201, 'interleaved hatch submission is 201')

  const d2 = await fetch(`${BASE}/api/assessments/${c2.body.id}`).then((r) => r.json())
  expect(d2.comparison && d2.comparison.available === true, 'second measurement has an available comparison')
  expect(d2.comparison.previous.id === c1.body.id,
    `predecessor is the prior same-hatch record #${c1.body.id}, not the interleaved hatch`)
  expect(d2.comparison.previous.hatch === '5H', 'predecessor summary identifies the hatch')
  const g1 = Math.log(m1.rh / 100) + (A * m1.ta) / (B + m1.ta)
  const td1 = (B * g1) / (A - g1)
  const g2 = Math.log(m2.rh / 100) + (A * m2.ta) / (B + m2.ta)
  const td2 = (B * g2) / (A - g2)
  const expectedChanges = {
    tg: m2.tg - m1.tg,
    ta: m2.ta - m1.ta,
    rh: m2.rh - m1.rh,
    td: td2 - td1,
    delta: (m2.tg - td2) - (m1.tg - td1),
  }
  for (const [k, v] of Object.entries(expectedChanges)) {
    expect(Math.abs(d2.comparison.changes[k] - v) < 1e-12,
      `unrounded ${k} change matches independent math: api=${d2.comparison.changes[k]} expected=${v}`)
  }
  // The changes really are unrounded: at least one differs from its own 2-dp rounding.
  expect(Object.values(d2.comparison.changes).some((v) => round2(v) !== v),
    'comparison changes are delivered unrounded')
  const chainList = await fetch(`${BASE}/api/assessments`).then((r) => r.json())
  expect(chainList.items.every((i) => i.comparison === undefined),
    'list items never carry comparison blocks')

  // 3c. Voyage "hatch overview": one LATEST snapshot per hatch, grouped by
  // the server (MAX(id) per hatch), not filtered client-side. The probe
  // independently derives the expected latest id per hatch from the full
  // list, so a server that grouped on created_at or dropped a hatch fails.
  const ovVoyage = 'ACCEPT-OV'
  const ovOther = 'ACCEPT-OV-OTHER'
  // Interleave two voyages across the same hatch numbers; 2P measured 3×.
  const ovIds = []
  ovIds.push((await post({ voyage: ovVoyage, hatch: '2P', tg: 24, ta: 20, rh: 70 })).body.id)
  await post({ voyage: ovOther, hatch: '2P', tg: 5, ta: 28, rh: 95 })
  ovIds.push((await post({ voyage: ovVoyage, hatch: '3H', tg: 25, ta: 20, rh: 70 })).body.id)
  ovIds.push((await post({ voyage: ovVoyage, hatch: '2P', tg: 23, ta: 20, rh: 70 })).body.id)
  await post({ voyage: ovOther, hatch: '3H', tg: 6, ta: 28, rh: 95 })
  ovIds.push((await post({ voyage: ovVoyage, hatch: '2P', tg: 26, ta: 20, rh: 70 })).body.id)
  ovIds.push((await post({ voyage: ovVoyage, hatch: '4H', tg: 16.357, ta: 20, rh: 70 })).body.id)

  const overviewRes = await fetch(`${BASE}/api/voyages/${encodeURIComponent(ovVoyage)}/hatches/latest`)
  expect(overviewRes.status === 200, `overview is 200 (got ${overviewRes.status})`)
  const overview = await overviewRes.json()
  expect(overview.voyage === ovVoyage, 'overview echoes the voyage code')

  // Independent expectation from the full (newest-first) list.
  const fullList = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items
  const expectedLatest = {}
  for (const it of fullList) {
    if (it.voyage === ovVoyage && !(it.hatch in expectedLatest)) {
      expectedLatest[it.hatch] = it // first seen per hatch is the latest
    }
  }
  const expectedHatches = Object.keys(expectedLatest).sort()
  expect(overview.items.length === expectedHatches.length,
    `one snapshot per hatch: ${overview.items.length} == ${expectedHatches.length}`)
  expect(overview.items.map((i) => i.hatch).join(',') === expectedHatches.join(','),
    `rows sorted by hatch: ${overview.items.map((i) => i.hatch).join(',')}`)
  for (const row of overview.items) {
    expect(row.id === expectedLatest[row.hatch].id,
      `${row.hatch} latest is record #${expectedLatest[row.hatch].id} (MAX id), got #${row.id}`)
    expect(row.voyage === ovVoyage, 'no row leaks from the interleaved other voyage')
    expect(row.comparison === undefined && row.formula === undefined,
      'snapshot rows are a lean read-only shape')
    // Values/verdict match the persisted latest record.
    const src = expectedLatest[row.hatch]
    expect(row.delta === src.delta && row.verdict === src.verdict,
      `${row.hatch} snapshot carries the latest record's own Δ and verdict`)
  }
  // The repeated hatch 2P resolves to the third (largest) id.
  const twoP = overview.items.find((i) => i.hatch === '2P')
  expect(twoP.id === Math.max(...ovIds.slice(0, 1), ovIds[2], ovIds[3]) && twoP.id === ovIds[3],
    'repeated measurements of 2P resolve to the newest record id')
  // Its detail link really serves that record.
  const linked = await fetch(`${BASE}/api/assessments/${twoP.id}`).then((r) => r.json())
  expect(linked.id === twoP.id && linked.hatch === '2P', 'a snapshot row links to its own detail')

  // The other voyage is grouped independently.
  const otherOv = await fetch(`${BASE}/api/voyages/${encodeURIComponent(ovOther)}/hatches/latest`).then((r) => r.json())
  expect(otherOv.items.length === 2 && otherOv.items.every((i) => i.voyage === ovOther),
    'the other voyage overview never shares rows despite equal hatch numbers')

  // Unknown voyage -> empty collection, not an error.
  const emptyOvRes = await fetch(`${BASE}/api/voyages/ACCEPT-OV-NO-SUCH/hatches/latest`)
  expect(emptyOvRes.status === 200, 'unknown voyage overview is still 200')
  const emptyOv = await emptyOvRes.json()
  expect(Array.isArray(emptyOv.items) && emptyOv.items.length === 0,
    'unknown voyage returns an empty items collection')

  // Malformed path percent-encoding -> explicit request error (400).
  const badEnc = await fetch(`${BASE}/api/voyages/a%zz/hatches/latest`)
  expect(badEnc.status === 400, `malformed path encoding is a 400 request error (got ${badEnc.status})`)

  // Existing POST/list/detail shapes are untouched by the new endpoint.
  const sampleDetail = await fetch(`${BASE}/api/assessments/${body.id}`).then((r) => r.json())
  expect(sampleDetail.formula && sampleDetail.comparison === undefined,
    'detail of the first measurement keeps formula and no comparison')

  // 3d. BATCH endpoint: one ordered array saved in a single transaction.
  // The probe independently checks in-batch predecessor linking with
  // interleaved AND repeated hatches, the per-hatch overview's latest row,
  // and whole-batch atomicity when a MIDDLE row is out of range.
  const bVoy = 'ACCEPT-BATCH'
  const bOther = 'ACCEPT-BATCH-OTHER'
  const batchRows = [
    { voyage: bVoy, hatch: '1H', tg: 25, ta: 20, rh: 70 },  // 1: 1H first
    { voyage: bVoy, hatch: '2H', tg: 24, ta: 20, rh: 70 },  // 2: 2H first
    { voyage: bOther, hatch: '1H', tg: 25, ta: 20, rh: 70 },// 3: other voyage
    { voyage: bVoy, hatch: '1H', tg: 23.5, ta: 21, rh: 75 },// 4: repeat 1H -> 1
    { voyage: bVoy, hatch: '2H', tg: 30, ta: 20, rh: 70 },  // 5: repeat 2H -> 2
    { voyage: bVoy, hatch: '1H', tg: 26, ta: 20, rh: 70 },  // 6: repeat 1H -> 4
  ]
  const batchRes = await postBatch(batchRows)
  expect(batchRes.status === 201, `batch of 6 is 201 (got ${batchRes.status})`)
  expect(batchRes.body.count === 6, 'batch response count is 6')
  expect(Array.isArray(batchRes.body.items) && batchRes.body.items.length === 6,
    'batch response carries six items in order')
  const bid = batchRes.body.items.map((it) => it.id)
  for (let i = 1; i < bid.length; i++) {
    expect(bid[i] === bid[i - 1] + 1, 'batch item ids are consecutive in creation order')
  }
  // Every item is the same single-assessment DTO shape (formula present,
  // comparison absent) and matches the probe's own recomputation.
  batchRes.body.items.forEach((it, i) => {
    const m = magnus(batchRows[i])
    expect(Math.abs(it.delta - m.delta) < 1e-12, `batch row ${i + 1} Δ matches independent math`)
    expect(!!it.formula && it.comparison === undefined,
      `batch row ${i + 1} keeps the single-DTO shape (formula yes, comparison no)`)
  })

  const bDetail = async (idx) =>
    fetch(`${BASE}/api/assessments/${bid[idx]}`).then((r) => r.json())
  expect((await bDetail(0)).comparison === undefined, 'in-batch first 1H measurement has no predecessor')
  expect((await bDetail(1)).comparison === undefined, 'in-batch first 2H measurement has no predecessor')
  expect((await bDetail(2)).comparison === undefined, 'other-voyage 1H is an independent first measurement')

  const b4 = await bDetail(3)
  expect(b4.comparison.available === true && b4.comparison.previous.id === bid[0],
    'later 1H row links to the EARLIER same-hatch batch row, not the interleaved 2H row')
  const b5 = await bDetail(4)
  expect(b5.comparison.available === true && b5.comparison.previous.id === bid[1],
    'later 2H row links to its own earlier batch row')
  const b6 = await bDetail(5)
  expect(b6.comparison.available === true && b6.comparison.previous.id === bid[3],
    'the third 1H row links to the immediately preceding in-batch 1H row')

  // The other voyage's 1H must not be linked to the identically-numbered 1H
  // rows of bVoy: it has no predecessor and the overview isolates it.
  const b3 = await bDetail(2)
  expect(b3.voyage === bOther, 'other-voyage row really belongs to the other voyage')

  // Overview latest per hatch = the LAST batch row of each hatch (MAX id).
  const bOvRes = await fetch(`${BASE}/api/voyages/${encodeURIComponent(bVoy)}/hatches/latest`)
  expect(bOvRes.status === 200, 'batch voyage overview is 200')
  const bOv = await bOvRes.json()
  const bByHatch = Object.fromEntries(bOv.items.map((it) => [it.hatch, it]))
  expect(Object.keys(bByHatch).sort().join(',') === '1H,2H', 'one latest snapshot per batch hatch')
  expect(bByHatch['1H'].id === bid[5] && bByHatch['2H'].id === bid[4],
    'overview latest items are the repeated rows (true creation order)')
  const bOvOther = await fetch(`${BASE}/api/voyages/${encodeURIComponent(bOther)}/hatches/latest`)
    .then((r) => r.json())
  expect(bOvOther.items.length === 1 && bOvOther.items[0].id === bid[2],
    'the interleaved other voyage is isolated despite the shared hatch number')

  // The history list reflects the real creation order immediately: the five
  // bVoy rows (batch indices 0,1,3,4,5) appear newest-first, and the other
  // voyage's row (bid[2]) is never among them.
  const bList = await fetch(`${BASE}/api/assessments`).then((r) => r.json())
  const bVoyIds = bList.items.filter((i) => i.voyage === bVoy).map((i) => i.id)
  expect(bVoyIds.join(',') === [bid[5], bid[4], bid[3], bid[1], bid[0]].join(','),
    'history lists the batch rows newest-first in true creation order')

  // A batch's new rows ALSO continue a chain that already existed in the
  // database (single POST first, then a batch repeat of the same hatch).
  const pre = await post({ voyage: 'ACCEPT-BATCH-PRE', hatch: '9H', tg: 25, ta: 20, rh: 70 })
  expect(pre.status === 201, 'pre-batch single submission is 201')
  const cont = await postBatch([
    { voyage: 'ACCEPT-BATCH-PRE', hatch: '8H', tg: 25, ta: 20, rh: 70 },
    { voyage: 'ACCEPT-BATCH-PRE', hatch: '9H', tg: 24, ta: 20, rh: 70 },
  ])
  expect(cont.status === 201, 'continuation batch is 201')
  const contDetail = await fetch(`${BASE}/api/assessments/${cont.body.items[1].id}`).then((r) => r.json())
  expect(contDetail.comparison.available === true &&
    contDetail.comparison.previous.id === pre.body.id,
    'a batch row continues the most recent valid DB predecessor for its hatch')

  // An out-of-range MIDDLE row rejects the WHOLE batch with a 1-based row
  // number and the original field error; nothing (including the legal rows
  // before and after it) may be persisted — no partial rows, no broken link.
  const rollVoy = 'ACCEPT-BATCH-ROLLBACK'
  const beforeBatch = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items.length
  const roll = await postBatch([
    { voyage: rollVoy, hatch: '1H', tg: 25, ta: 20, rh: 70 },  // legal
    { voyage: rollVoy, hatch: '1H', tg: 999, ta: 20, rh: 70 }, // row 2: out of range
    { voyage: rollVoy, hatch: '2H', tg: 26, ta: 20, rh: 70 },  // legal, must not save
  ])
  expect(roll.status === 422, `middle out-of-range row is 422 (got ${roll.status})`)
  expect(roll.body.rows.length === 1 && roll.body.rows[0].row === 2, '422 names row 2')
  const rf = roll.body.rows[0].fields[0]
  expect(rf.field === 'tg' && rf.code === 'out_of_range', 'the original tg field error is returned')
  const afterBatch = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items.length
  expect(afterBatch === beforeBatch, 'the whole invalid batch persisted no rows')
  const rollList = await fetch(`${BASE}/api/assessments`).then((r) => r.json())
  expect(rollList.items.every((i) => i.voyage !== rollVoy),
    'no row of the rolled-back voyage exists (no partial chain)')

  // Structural guards stay 400 (request-format errors), not 422, and save nothing.
  for (const [hint, payload] of [
    ['empty array', { measurements: [] }],
    ['over cap', { measurements: Array.from({ length: 21 }, () => ({
      voyage: rollVoy, hatch: '1H', tg: 25, ta: 20, rh: 70 })) }],
    ['non-array', { measurements: {} }],
  ]) {
    const rr = await fetch(`${BASE}/api/assessments/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    expect(rr.status === 400, `${hint} is a 400 format error (got ${rr.status})`)
  }
  const nonObject = await fetch(`${BASE}/api/assessments/batch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ measurements: [{ voyage: 'x', hatch: 'y', tg: 25, ta: 20, rh: 70 }, 123] }),
  })
  expect(nonObject.status === 400, 'a non-object row is a 400 format error')
  const afterStruct = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items.length
  expect(afterStruct === afterBatch, 'structural rejections persist nothing')

  // 3e. ROBUSTNESS CHECKS: eight server-evaluated +/- boundary corners.
  // The probe independently recomputes every corner with its own Magnus
  // implementation and band rule; a fake/stub API cannot match all eight.
  const cornerSigns = [
    ['-', '-', '-'], ['-', '-', '+'], ['-', '+', '-'], ['-', '+', '+'],
    ['+', '-', '-'], ['+', '-', '+'], ['+', '+', '-'], ['+', '+', '+'],
  ]
  const expectedCornersOf = (m, eps, originalVerdict) => cornerSigns.map(([sg, sa, sr], i) => {
    const c = {
      ...m,
      tg: m.tg + (sg === '-' ? -eps.tg : eps.tg),
      ta: m.ta + (sa === '-' ? -eps.ta : eps.ta),
      rh: m.rh + (sr === '-' ? -eps.rh : eps.rh),
    }
    const { gamma, td, delta } = magnus(c)
    const verdict = verdictFor(delta)
    return {
      index: i + 1, tg_sign: sg, ta_sign: sa, rh_sign: sr,
      tg: c.tg, ta: c.ta, rh: c.rh,
      gamma, td, delta,
      gamma_display: round2(gamma), td_display: round2(td), delta_display: round2(delta),
      verdict,
      matches_original: verdict === originalVerdict,
    }
  })

  // ---- stable sample far from the boundary ----
  const stableM = { voyage: 'ACCEPT-ROBUST-S', hatch: '3H', tg: 25, ta: 20, rh: 70 }
  const stableAssess = await post(stableM)
  expect(stableAssess.status === 201, 'stable-sample assessment is 201')
  const stableEps = { tg_eps: 0.5, ta_eps: 0.5, rh_eps: 1 }
  const stableCheck = await postCheck(stableAssess.body.id, stableEps)
  expect(stableCheck.status === 201, `stable check is 201 (got ${stableCheck.status})`)
  expect(stableCheck.body.status === 'stable', 'all corners agreeing -> stable')
  expect(JSON.stringify(stableCheck.body.verdicts) === JSON.stringify(['allowed']),
    `verdict set contains only the original verdict, got ${JSON.stringify(stableCheck.body.verdicts)}`)
  expect(stableCheck.body.assessment_id === stableAssess.body.id, 'check names the origin assessment id')
  expect(stableCheck.body.corners.length === 8, 'exactly eight boundary corners')

  const stableExpected = expectedCornersOf(stableM, { tg: 0.5, ta: 0.5, rh: 1 }, 'allowed')
  stableCheck.body.corners.forEach((c, i) => {
    const e = stableExpected[i]
    expect(c.tg_sign === e.tg_sign && c.ta_sign === e.ta_sign && c.rh_sign === e.rh_sign,
      `corner ${i + 1} signs are ${e.tg_sign}${e.ta_sign}${e.rh_sign}`)
    expect(Math.abs(c.tg - e.tg) < 1e-12 && Math.abs(c.ta - e.ta) < 1e-12 && Math.abs(c.rh - e.rh) < 1e-12,
      `corner ${i + 1} inputs are centre ${e.tg_sign}${e.ta_sign}${e.rh_sign} epsilon`)
    expect(Math.abs(c.gamma - e.gamma) < 1e-12, `corner ${i + 1} γ matches independent math`)
    expect(Math.abs(c.td - e.td) < 1e-12, `corner ${i + 1} Td matches independent math`)
    expect(Math.abs(c.delta - e.delta) < 1e-12, `corner ${i + 1} unrounded Δ matches independent math`)
    expect(c.verdict === e.verdict, `corner ${i + 1} verdict ${c.verdict} === independent ${e.verdict}`)
    expect(c.matches_original === true,
      `corner ${i + 1} server flag matches_original is true (stable sample)`)
  })
  // The frozen original assessment snapshot carries the origin values.
  expect(stableCheck.body.assessment &&
    stableCheck.body.assessment.id === stableAssess.body.id &&
    stableCheck.body.assessment.verdict === 'allowed',
    'the check embeds an immutable snapshot of the original assessment')
  expect(stableCheck.body.tolerances &&
    stableCheck.body.tolerances.tg === 0.5 &&
    stableCheck.body.tolerances.ta === 0.5 &&
    stableCheck.body.tolerances.rh === 1,
    'tolerances are echoed back as tg/ta/rh magnitudes')

  // Refresh/reopen by CHECK NUMBER reproduces the identical frozen record.
  const stableReload = await getCheck(stableCheck.body.id)
  expect(stableReload.status === 200, 'a check is reachable by its own number')
  expect(JSON.stringify(stableReload.body.corners) === JSON.stringify(stableCheck.body.corners),
    'reload returns the identical eight frozen corners')
  expect(stableReload.body.status === 'stable' &&
    JSON.stringify(stableReload.body.verdicts) === JSON.stringify(['allowed']),
    'reload keeps the stable status and verdict set')
  expect(stableReload.body.assessment_id === stableAssess.body.id, 'reload keeps the origin id')

  // ---- sensitive sample just inside Δ = 2 ----
  const sensM = { voyage: 'ACCEPT-ROBUST-X', hatch: '3H', tg: 16.36, ta: 20, rh: 70 }
  const sensAssess = await post(sensM)
  expect(sensAssess.body.verdict === 'allowed', `unrounded Δ≈2.0008 -> allowed (got ${sensAssess.body.verdict})`)
  const sensEps = { tg_eps: 0.01, ta_eps: 0.01, rh_eps: 0.5 }
  const sensCheck = await postCheck(sensAssess.body.id, sensEps)
  expect(sensCheck.status === 201 && sensCheck.body.status === 'sensitive',
    `corners spanning two verdicts -> sensitive (got ${sensCheck.status}/${sensCheck.body?.status})`)
  expect(JSON.stringify(sensCheck.body.verdicts) === JSON.stringify(['allowed', 'retest']),
    `verdict set is {allowed, retest} in first-encounter order, got ${JSON.stringify(sensCheck.body.verdicts)}`)
  const sensExpected = expectedCornersOf(sensM, { tg: 0.01, ta: 0.01, rh: 0.5 }, 'allowed')
  let flipped = 0
  sensCheck.body.corners.forEach((c, i) => {
    const e = sensExpected[i]
    expect(Math.abs(c.delta - e.delta) < 1e-12 && c.verdict === e.verdict,
      `sensitive corner ${i + 1} matches independent recomputation`)
    expect(c.matches_original === e.matches_original,
      `corner ${i + 1} server matches_original flag matches the probe's own verdict comparison`)
    if (c.verdict !== 'allowed') flipped += 1
  })
  expect(flipped === 4, `exactly four corners flip to retest (got ${flipped})`)
  // Precisely the four RH+ corners cross the boundary.
  expect(sensCheck.body.corners.filter((c) => c.rh_sign === '+').every((c) => c.verdict === 'retest'),
    'the four humid (RH+) corners are the ones that retest')

  // Negative-side sensitivity: Δ≈-2.0022 denied, drier corners retest.
  const negM = { voyage: 'ACCEPT-ROBUST-N', hatch: '3H', tg: 12.357, ta: 20, rh: 70 }
  const negAssess = await post(negM)
  expect(negAssess.body.verdict === 'denied', `unrounded Δ≈-2.0022 -> denied (got ${negAssess.body.verdict})`)
  const negCheck = await postCheck(negAssess.body.id, sensEps)
  expect(negCheck.body.status === 'sensitive', 'negative boundary side is sensitive too')
  expect(JSON.stringify(negCheck.body.verdicts) === JSON.stringify(['retest', 'denied']),
    `set starts with the first corner's retest then denied, got ${JSON.stringify(negCheck.body.verdicts)}`)

  // ---- illegal tolerances: explicit field feedback, no record ----
  const beforeChecks = stableCheck.body.id
  const badChecks = [
    { body: { tg_eps: 0, ta_eps: 0.5, rh_eps: 1 }, field: 'tg_eps', code: 'not_positive' },
    { body: { tg_eps: -1, ta_eps: 0.5, rh_eps: 1 }, field: 'tg_eps', code: 'not_positive' },
    { body: { tg_eps: 40, ta_eps: 0.5, rh_eps: 1 }, field: 'tg_eps', code: 'out_of_range' }, // 25+40 > 60
    { body: { tg_eps: 0.5, ta_eps: 0.5, rh_eps: 70 }, field: 'rh_eps', code: 'out_of_range' }, // 70-70 < 1
    { raw: '{"tg_eps":1e999,"ta_eps":0.5,"rh_eps":1}', field: 'tg_eps', code: 'not_finite' },
    { body: { ta_eps: 0.5, rh_eps: 1 }, field: 'tg_eps', code: 'required' },
  ]
  for (const c of badChecks) {
    const r = c.raw ? await postCheck(stableAssess.body.id, c.raw) : await postCheck(stableAssess.body.id, c.body)
    expect(r.status === 422, `rejected tolerance -> 422 (${c.field}/${c.code}, got ${r.status})`)
    const hit = (r.body.fields || []).find((f) => f.field === c.field && f.code === c.code)
    expect(!!hit, `422 names field ${c.field} with code ${c.code}`)
  }
  // A missing ORIGIN assessment is a 422 assessment/not_found field error.
  const noOrigin = await postCheck(999999, { tg_eps: 0.5, ta_eps: 0.5, rh_eps: 1 })
  expect(noOrigin.status === 422 && noOrigin.body.fields[0].field === 'assessment' &&
    noOrigin.body.fields[0].code === 'not_found',
    'a missing origin assessment gives assessment/not_found field feedback')
  // A magnitude landing EXACTLY on a legal endpoint is accepted (closed
  // interval): tg/ta 20 ± 40 spans -20..60 exactly, rh 50 ± 49 spans 1..99.
  const edgeAssess = await post({ voyage: 'ACCEPT-ROBUST-E', hatch: '3H', tg: 20, ta: 20, rh: 50 })
  expect(edgeAssess.status === 201, 'edge-case assessment is 201')
  const edge = await postCheck(edgeAssess.body.id, { tg_eps: 40, ta_eps: 40, rh_eps: 49 })
  expect(edge.status === 201, `centre 20 ± 40 spans -20..60 exactly -> 201 (got ${edge.status})`)
  const edgeFirst = edge.body.corners[0]
  const edgeLast = edge.body.corners[7]
  expect(edgeFirst.tg === -20 && edgeFirst.ta === -20 && edgeFirst.rh === 1,
    `the --- corner reaches tg/ta=-20, rh=1, got ${edgeFirst.tg}/${edgeFirst.ta}/${edgeFirst.rh}`)
  expect(edgeLast.tg === 60 && edgeLast.ta === 60 && edgeLast.rh === 99,
    `the +++ corner reaches tg/ta=60, rh=99, got ${edgeLast.tg}/${edgeLast.ta}/${edgeLast.rh}`)
  // Rejected requests consumed no id: the next legal check is exactly one id
  // after the last accepted one (stable + sensitive + negative + edge = +3).
  const nextLegal = await postCheck(stableAssess.body.id, { tg_eps: 0.2, ta_eps: 0.2, rh_eps: 0.5 })
  expect(nextLegal.status === 201 && nextLegal.body.id === beforeChecks + 4,
    `rejected checks persist no record (next id ${nextLegal.body?.id} expected ${beforeChecks + 4})`)
  // An unknown check number is a 404.
  const missingCheck = await getCheck(888888)
  expect(missingCheck.status === 404, 'an unknown check number is 404')
  // Checks never appear among assessments or change that list.
  const robustAssessList = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items
  expect(robustAssessList.every((i) => i.corners === undefined && i.tolerances === undefined),
    'robustness data never leaks into assessment list items')

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

  // 6b. Structural/format errors are 400 (malformed request body), not 422
  // field validation, and never persist a record.
  const structBefore = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items.length
  const structCases = [
    { raw: '{"voyage":"STRUCT","hatch":"H","tg":25,"ta":20,"rh":70}]', hint: 'stray ]' },
    { raw: '{"voyage":"STRUCT","hatch":"H","tg":25,"ta":20,"rh":70} GARBAGE', hint: 'trailing text' },
    { raw: '{"voyage":"STRUCT","hatch":"H","tg":25,"ta":20,"rh":70,"rh":1}', hint: 'duplicate key' },
    { raw: 'null', hint: 'top-level null' },
    { raw: '[]', hint: 'top-level array' },
  ]
  for (const c of structCases) {
    const r = await post(c.raw)
    expect(r.status === 400, `${c.hint} is rejected as 400 format error (got ${r.status})`)
    expect(r.body && typeof r.body.error === 'string' && r.body.fields === undefined,
      `${c.hint} reports a body-level error without fabricated field errors`)
  }
  const nullCase = await post('null')
  expect(typeof nullCase.body.error === 'string' && nullCase.body.error.includes('格式错误'),
    'top-level null is explicitly diagnosed as a request body format error')
  const structAfter = (await fetch(`${BASE}/api/assessments`).then((r) => r.json())).items.length
  expect(structAfter === structBefore,
    `no record persisted on 400 (${structBefore} before, ${structAfter} after)`)

  console.log('\nALL ACCEPTANCE CHECKS PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
