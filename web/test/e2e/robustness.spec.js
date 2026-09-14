import { expect, test } from '@playwright/test'

// End-to-end acceptance for robustness checks, driven through the REAL stack
// (nginx/vite preview -> Gin -> SQLite):
//
//   1. a STABLE sample far from the verdict boundary: all eight server
//      corners keep the original verdict;
//   2. a SENSITIVE sample sitting just inside Δ = 2: four corners flip to
//      retest within the instruments' symmetric error box;
//   3. illegal error magnitudes are rejected (422 field feedback) and never
//      consume an id / create a check record;
//   4. refresh and reopening BY CHECK NUMBER reproduce the same frozen
//      server results.
//
// Every boundary number/verdict rendered by the page is compared against the
// API's own JSON: the browser generates neither the corners nor the verdicts.

const RUN = Date.now()

async function postAssessment(request, { voyage, hatch, tg, ta = 20, rh = 70 }) {
  const res = await request.post('/api/assessments', {
    headers: { 'Content-Type': 'application/json' },
    data: { voyage, hatch, tg, ta, rh },
  })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

async function postCheck(request, assessmentId, tolerances) {
  const res = await request.post(`/api/assessments/${assessmentId}/robustness-checks`, {
    headers: { 'Content-Type': 'application/json' },
    data: tolerances,
  })
  const text = await res.text()
  return { status: res.status(), body: text ? JSON.parse(text) : null }
}

test('stable sample: eight corners keep the verdict; refresh and reopen by check number are identical', async ({ page, request }) => {
  const voyage = `V-RB-STABLE-${RUN}`
  const a = await postAssessment(request, { voyage, hatch: '3H', tg: 25, ta: 20, rh: 70 })
  expect(a.verdict).toBe('allowed')

  // Launch from the assessment detail.
  await page.goto(`/assessments/${a.id}`)
  await expect(page.locator('[data-test=robustness-entry]')).toBeVisible()
  await page.locator('[data-test=robustness-entry] a').click()
  await expect(page).toHaveURL(`/assessments/${a.id}/robustness-checks/new`)
  await expect(page.locator('[data-test=origin-summary]')).toContainText('允许通风')

  await page.fill('#rf-tg_eps', '0.5')
  await page.fill('#rf-ta_eps', '0.5')
  await page.fill('#rf-rh_eps', '1')
  await page.click('[data-test=robustness-submit]')

  // Submission enters the INDEPENDENT check detail, by check number.
  await page.waitForURL(/\/robustness-checks\/\d+$/)
  const checkUrl = page.url()
  const checkId = Number(checkUrl.match(/\/robustness-checks\/(\d+)$/)[1])

  const api = await request.get(`/api/robustness-checks/${checkId}`).then((r) => r.json())
  expect(api.status).toBe('stable')
  expect(api.verdicts).toEqual(['allowed'])
  expect(api.assessment_id).toBe(a.id)
  expect(api.corners).toHaveLength(8)

  await expect(page.locator('[data-test=check-status]')).toContainText('稳定')
  await expect(page.locator('[data-test=risk-stable]')).toBeVisible()
  await expect(page.locator('[data-test=risk-sensitive]')).toHaveCount(0)

  // Error ranges around the original values.
  const detail = page.locator('[data-test=check-detail]')
  await expect(detail).toContainText('24.50 ~ 25.50')
  await expect(detail).toContainText('69.00 ~ 71.00')

  // Every rendered corner matches the API JSON field-for-field (the page
  // computes none of these).
  const rows = page.locator('[data-test=corner-row]')
  await expect(rows).toHaveCount(8)
  for (let i = 0; i < 8; i += 1) {
    const c = api.corners[i]
    await expect(rows.nth(i)).toContainText(String(c.delta))
    await expect(rows.nth(i)).toContainText(c.verdict === 'allowed' ? '允许通风' : c.verdict)
  }
  // Original snapshot stays on the page and links back to the assessment.
  await expect(detail).toContainText(a.voyage)
  await expect(page.locator(`a[href="/assessments/${a.id}"]`).first()).toBeVisible()

  // Refresh: identical frozen server results.
  await page.reload()
  await expect(page.locator('[data-test=check-status]')).toContainText('稳定')
  await expect(rows).toHaveCount(8)

  // Reopen BY CHECK NUMBER from the home page entry.
  await page.goto('/')
  await page.fill('#check-id-input', String(checkId))
  await page.click('[data-test=reopen-check-btn]')
  await expect(page).toHaveURL(`/robustness-checks/${checkId}`)
  await expect(page.locator('[data-test=check-status]')).toContainText('稳定')
  await expect(page.locator('[data-test=corner-row]')).toHaveCount(8)
})

test('sensitive sample: four humid corners flip allowed->retest and the page warns; reload keeps the frozen set', async ({ page, request }) => {
  const voyage = `V-RB-SENS-${RUN}`
  // Δ ≈ 2.0008 unrounded -> "allowed" although display rounds near 2.00.
  const a = await postAssessment(request, { voyage, hatch: '3H', tg: 16.36, ta: 20, rh: 70 })
  expect(a.verdict).toBe('allowed')

  const created = await postCheck(request, a.id, { tg_eps: 0.01, ta_eps: 0.01, rh_eps: 0.5 })
  expect(created.status).toBe(201)
  expect(created.body.status).toBe('sensitive')
  expect(created.body.verdicts).toEqual(['allowed', 'retest'])
  const checkId = created.body.id

  await page.goto(`/robustness-checks/${checkId}`)
  await expect(page.locator('[data-test=check-status]')).toContainText('敏感')
  const risk = page.locator('[data-test=risk-sensitive]')
  await expect(risk).toBeVisible()
  await expect(risk).toContainText('4 组')
  await expect(risk).toContainText('不得仅凭原结论操作')
  await expect(risk).toContainText('允许通风')
  await expect(risk).toContainText('暂停并复测')

  // Exactly the four RH+ corners (indices 2,4,6,8) diverge and are highlighted.
  const rows = page.locator('[data-test=corner-row]')
  await expect(rows).toHaveCount(8)
  await expect(page.locator('tr.corner-diverges')).toHaveCount(4)
  const divergingIdx = [1, 3, 5, 7]
  for (const i of divergingIdx) {
    await expect(rows.nth(i)).toContainText('暂停并复测')
    expect(await rows.nth(i).evaluate((tr) => tr.classList.contains('corner-diverges'))).toBe(true)
  }
  for (const i of [0, 2, 4, 6]) {
    await expect(rows.nth(i)).toContainText('允许通风')
  }

  // Unrounded served deltas render verbatim (not 2-dp re-derivations).
  for (const c of created.body.corners) {
    await expect(rows.nth(c.index - 1)).toContainText(String(c.delta))
  }

  // Reload reproduces the same immutable verdict set and status.
  await page.reload()
  const again = await request.get(`/api/robustness-checks/${checkId}`).then((r) => r.json())
  expect(again.corners).toEqual(created.body.corners)
  expect(again.verdicts).toEqual(['allowed', 'retest'])
  await expect(page.locator('tr.corner-diverges')).toHaveCount(4)
})

test('illegal tolerances get explicit field feedback and never persist a check', async ({ page, request }) => {
  const voyage = `V-RB-BAD-${RUN}`
  const a = await postAssessment(request, { voyage, hatch: '3H', tg: 25, ta: 20, rh: 70 })

  // A legal check first fixes the next id.
  const ok = await postCheck(request, a.id, { tg_eps: 0.5, ta_eps: 0.5, rh_eps: 1 })
  expect(ok.status).toBe(201)
  const nextId = ok.body.id + 1

  const cases = [
    [{ tg_eps: 0, ta_eps: 0.5, rh_eps: 1 }, 'tg_eps', 'not_positive'],
    [{ tg_eps: -1, ta_eps: 0.5, rh_eps: 1 }, 'tg_eps', 'not_positive'],
    [{ tg_eps: 40, ta_eps: 0.5, rh_eps: 1 }, 'tg_eps', 'out_of_range'], // 25+40 > 60
    [{ tg_eps: 0.5, ta_eps: 0.5, rh_eps: 70 }, 'rh_eps', 'out_of_range'], // 70-70 < 1
  ]
  for (const [payload, field, code] of cases) {
    const r = await postCheck(request, a.id, payload)
    expect(r.status, JSON.stringify(r.body)).toBe(422)
    const names = r.body.fields.map((f) => f.field)
    const codes = r.body.fields.map((f) => f.code)
    expect(names).toContain(field)
    expect(codes).toContain(code)
  }

  // The non-finite literal 1e999 is a not_finite field error.
  const res = await request.post(`/api/assessments/${a.id}/robustness-checks`, {
    headers: { 'Content-Type': 'application/json' },
    data: '{"tg_eps":1e999,"ta_eps":0.5,"rh_eps":1}',
  })
  expect(res.status()).toBe(422)
  const body = await res.json()
  expect(body.fields[0].field).toBe('tg_eps')
  expect(body.fields[0].code).toBe('not_finite')

  // None of the rejected requests consumed an id: the next successfully
  // created check takes exactly nextId.
  const second = await postCheck(request, a.id, { tg_eps: 0.2, ta_eps: 0.2, rh_eps: 0.5 })
  expect(second.status).toBe(201)
  expect(second.body.id).toBe(nextId)
  // And there is still no check at any id the rejected calls might have used.
  const missing = await request.get(`/api/robustness-checks/${nextId + 1}`)
  expect(missing.status()).toBe(404)

  // A missing origin assessment is a 422 assessment/not_found field error.
  const noOrigin = await postCheck(request, 999999, { tg_eps: 0.5, ta_eps: 0.5, rh_eps: 1 })
  expect(noOrigin.status).toBe(422)
  expect(noOrigin.body.fields[0].field).toBe('assessment')
  expect(noOrigin.body.fields[0].code).toBe('not_found')

  // UI: an out-of-range magnitude is marked under the field and keeps input.
  await page.goto(`/assessments/${a.id}/robustness-checks/new`)
  await page.fill('#rf-tg_eps', '0.5')
  await page.fill('#rf-ta_eps', '0.5')
  await page.fill('#rf-rh_eps', '999')
  await page.click('[data-test=robustness-submit]')
  await expect(page.locator('#rerr-rh_eps')).toContainText('合法区间')
  await expect(page).toHaveURL(/\/robustness-checks\/new$/) // stayed on the form
})

test('an unknown or unreadable check offers only the history entry, never a direct link back to the origin assessment', async ({ page, request }) => {
  // --- 404: the check number does not exist ---
  const res = await request.get('/api/robustness-checks/888888')
  expect(res.status()).toBe(404)

  await page.goto('/robustness-checks/888888')
  const missing = page.locator('[data-test=check-missing]')
  await expect(missing).toBeVisible()
  const back = missing.locator('a')
  await expect(back).toHaveAttribute('href', '/')

  // No link anywhere on the page leads straight back to an origin assessment;
  // the only way out is the history area.
  expect(await page.locator('a[href^="/assessments/"]').count()).toBe(0)

  await back.click()
  await expect(page).toHaveURL(/\/$/)

  // --- 5xx: the check exists but reading it fails ---
  await page.route('**/api/robustness-checks/777777', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: '读取失败' }),
    }))
  await page.goto('/robustness-checks/777777')
  const failed = page.locator('[data-test=check-error]')
  await expect(failed).toBeVisible()
  await expect(failed.locator('a')).toHaveAttribute('href', '/')
  expect(await page.locator('a[href^="/assessments/"]').count()).toBe(0)

  await failed.locator('a').click()
  await expect(page).toHaveURL(/\/$/)
})
