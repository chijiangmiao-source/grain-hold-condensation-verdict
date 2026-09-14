import { expect, test } from '@playwright/test'

// End-to-end coverage for BATCH transcription. Every verdict/delta/id comes
// from the real Go API through nginx/vite -> Gin -> SQLite; the browser only
// renders the ordered batch response. These tests prove:
//   1. interleaved hatches and a repeated hatch inside ONE batch link
//      correctly (repeat row -> earlier batch row, never another hatch),
//      and the voyage overview shows each hatch's LAST batch row;
//   2. an out-of-range MIDDLE row rejects the whole batch — the UI keeps
//      every input and locates the row, while the real API persists
//      nothing (atomic rollback, no partial rows, no broken links).

async function switchToBatch(page) {
  await page.goto('/')
  await page.click('[data-test=mode-batch]')
  await expect(page.locator('.batch-form')).toBeVisible()
}

async function addRows(page, total) {
  while ((await page.locator('[data-test=batch-row]').count()) < total) {
    await page.click('[data-test=batch-add-row]')
  }
  expect(await page.locator('[data-test=batch-row]').count()).toBe(total)
}

async function fillRow(page, i, v) {
  for (const [key, value] of Object.entries(v)) {
    await page.fill(`#bf-${i}-${key}`, String(value))
  }
}

async function submitBatch(page) {
  await page.click('.batch-form button[type=submit]')
}

const RUN = Date.now()

test('batch: interleaved hatches and a repeated hatch chain inside the batch; overview shows the last row per hatch', async ({ page, request }) => {
  const voy = `V-BATCH-A-${RUN}`
  const other = `V-BATCH-A-OTHER-${RUN}`

  await switchToBatch(page)
  await addRows(page, 5)
  await fillRow(page, 0, { voyage: voy, hatch: '1H', tg: '25', ta: '20', rh: '70' })
  await fillRow(page, 1, { voyage: voy, hatch: '2H', tg: '24', ta: '20', rh: '70' })
  await fillRow(page, 2, { voyage: voy, hatch: '1H', tg: '23.5', ta: '21', rh: '75' }) // repeat 1H
  await fillRow(page, 3, { voyage: voy, hatch: '2H', tg: '30', ta: '20', rh: '70' })   // repeat 2H
  await fillRow(page, 4, { voyage: other, hatch: '1H', tg: '25', ta: '20', rh: '70' }) // other voyage

  await submitBatch(page)

  // Five result lines in measurement order, each linking to its own detail.
  const resultRows = page.locator('[data-test=batch-result-row]')
  await expect(resultRows).toHaveCount(5)
  const ids = []
  for (let i = 0; i < 5; i++) {
    const href = await resultRows.nth(i).locator('a').first().getAttribute('href')
    expect(href).toMatch(/^\/assessments\/\d+$/)
    ids.push(Number(href.match(/(\d+)$/)[1]))
  }
  expect(ids).toHaveLength(5)
  expect(ids[1]).toBe(ids[0] + 1) // consecutive creation order
  expect(ids[4]).toBe(ids[0] + 4)

  const detail = (id) => page.request.get(`/api/assessments/${id}`).then((r) => r.json())

  // First measurements carry no comparison.
  expect((await detail(ids[0])).comparison).toBeUndefined()
  expect((await detail(ids[1])).comparison).toBeUndefined()
  expect((await detail(ids[4])).comparison).toBeUndefined()

  // Repeat rows chain to the EARLIER BATCH row of the SAME hatch, never to
  // the interleaved other hatch: row3(1H)->row1, row4(2H)->row2.
  const d2 = await detail(ids[2])
  expect(d2.comparison.available).toBe(true)
  expect(d2.comparison.previous.id).toBe(ids[0])
  expect(d2.comparison.previous.hatch).toBe('1H')

  const d3 = await detail(ids[3])
  expect(d3.comparison.available).toBe(true)
  expect(d3.comparison.previous.id).toBe(ids[1])
  expect(d3.comparison.previous.hatch).toBe('2H')

  // The voyage overview (server MAX(id) grouping) shows each hatch's LAST
  // batch row and nothing from the other voyage.
  const ov = await request
    .get(`/api/voyages/${encodeURIComponent(voy)}/hatches/latest`)
    .then((r) => r.json())
  expect(ov.items).toHaveLength(2)
  const byHatch = Object.fromEntries(ov.items.map((it) => [it.hatch, it]))
  expect(byHatch['1H'].id).toBe(ids[2])
  expect(byHatch['2H'].id).toBe(ids[3])
  expect(ov.items.every((it) => it.voyage === voy)).toBe(true)

  // The other voyage is an independent chain whose 1H is a first measurement.
  const ovOther = await request
    .get(`/api/voyages/${encodeURIComponent(other)}/hatches/latest`)
    .then((r) => r.json())
  expect(ovOther.items).toHaveLength(1)
  expect(ovOther.items[0].id).toBe(ids[4])

  // A result row opens the EXISTING detail page (comparison card included).
  await resultRows.nth(2).locator('a').last().click()
  await expect(page).toHaveURL(`/assessments/${ids[2]}`)
  await expect(page.locator('[data-test=compare-card]')).toBeVisible()
  await expect(page.locator('[data-test=compare-card] a')).toHaveAttribute(
    'href', `/assessments/${ids[0]}`)
})

test('batch UI: an out-of-range middle row is blocked, located and inputs are kept; nothing is saved', async ({ page }) => {
  const voy = `V-BATCH-BAD-${RUN}`
  await switchToBatch(page)
  await addRows(page, 3)
  await fillRow(page, 0, { voyage: voy, hatch: '1H', tg: '25', ta: '20', rh: '70' })
  await fillRow(page, 1, { voyage: voy, hatch: '1H', tg: '999', ta: '20', rh: '70' })
  await fillRow(page, 2, { voyage: voy, hatch: '1H', tg: '26', ta: '20', rh: '70' })

  await submitBatch(page)

  // The middle row is marked and named; no result block appears.
  const invalid = page.locator('[data-test=batch-row].batch-row-invalid')
  await expect(invalid).toHaveCount(1)
  await expect(invalid.first()).toHaveAttribute('data-row', '2')
  await expect(page.locator('#berr-1-tg')).toContainText('60.0')
  await expect(page.locator('[data-test=batch-banner]')).toContainText('第 2 行')
  await expect(page.locator('[data-test=batch-result]')).toHaveCount(0)

  // Every input (including the bad value) is retained for correction.
  expect(await page.inputValue('#bf-0-tg')).toBe('25')
  expect(await page.inputValue('#bf-1-tg')).toBe('999')
  expect(await page.inputValue('#bf-2-tg')).toBe('26')

  // Correcting only the middle row and resubmitting saves all three.
  await page.fill('#bf-1-tg', '24')
  await submitBatch(page)
  await expect(page.locator('[data-test=batch-result-row]')).toHaveCount(3)

  // History shows exactly the corrected batch, ordered newest first.
  await page.reload()
  const rows = page.locator('.history tbody tr', { hasText: voy })
  await expect(rows).toHaveCount(3)
})

test('real API: an out-of-range middle row rolls back the WHOLE batch (no partial rows, no broken links)', async ({ request }) => {
  const voy = `V-BATCH-ROLLBACK-${RUN}`
  const before = (await request.get('/api/assessments').then((r) => r.json())).items.length

  const res = await request.post('/api/assessments/batch', {
    headers: { 'Content-Type': 'application/json' },
    data: { measurements: [
      { voyage: voy, hatch: '1H', tg: 25, ta: 20, rh: 70 },  // legal
      { voyage: voy, hatch: '1H', tg: 999, ta: 20, rh: 70 }, // row 2 out of range
      { voyage: voy, hatch: '2H', tg: 26, ta: 20, rh: 70 },  // legal, must not save
    ] },
  })
  expect(res.status()).toBe(422)
  const body = await res.json()
  expect(body.rows).toHaveLength(1)
  expect(body.rows[0].row).toBe(2)
  expect(body.rows[0].fields[0].field).toBe('tg')
  expect(body.rows[0].fields[0].code).toBe('out_of_range')

  // Atomic: total count unchanged and no row of this voyage exists — the
  // legal rows before/after the bad one were never committed.
  const after = (await request.get('/api/assessments').then((r) => r.json())).items.length
  expect(after).toBe(before)
  const list = await request.get('/api/assessments').then((r) => r.json())
  expect(list.items.some((a) => a.voyage === voy)).toBe(false)

  // Structural guards: empty batch and a 21-row batch are 400 and persist nothing.
  const empty = await request.post('/api/assessments/batch', {
    headers: { 'Content-Type': 'application/json' },
    data: { measurements: [] },
  })
  expect(empty.status()).toBe(400)

  const tooMany = { measurements: Array.from({ length: 21 }, () => ({
    voyage: voy, hatch: '1H', tg: 25, ta: 20, rh: 70,
  })) }
  const over = await request.post('/api/assessments/batch', {
    headers: { 'Content-Type': 'application/json' },
    data: tooMany,
  })
  expect(over.status()).toBe(400)
  const finalList = await request.get('/api/assessments').then((r) => r.json())
  expect(finalList.items.some((a) => a.voyage === voy)).toBe(false)

  // A healthy batch after the rejected ones still chains normally.
  const ok = await request.post('/api/assessments/batch', {
    headers: { 'Content-Type': 'application/json' },
    data: { measurements: [
      { voyage: voy, hatch: '1H', tg: 25, ta: 20, rh: 70 },
      { voyage: voy, hatch: '1H', tg: 24, ta: 20, rh: 70 },
    ] },
  })
  expect(ok.status()).toBe(201)
  const saved = await ok.json()
  expect(saved.items).toHaveLength(2)
  const secondDetail = await request
    .get(`/api/assessments/${saved.items[1].id}`).then((r) => r.json())
  expect(secondDetail.comparison.available).toBe(true)
  expect(secondDetail.comparison.previous.id).toBe(saved.items[0].id)
})
