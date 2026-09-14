import { describe, expect, it, vi, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import HomePage from '@/pages/HomePage.vue'

// Batch-mode coverage for HomePage: ordered transcription, server-rendered
// results, row-level 422 with retained inputs, and the 20-row cap.

function mountPage() {
  // A real router (not a stubbed RouterLink) so each result row's link text
  // ("#<id>") and href are rendered and asserted.
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomePage },
      { path: '/assessments/:id', component: { template: '<div/>' } },
      { path: '/voyages/:voyage/hatches/latest', component: { template: '<div/>' } },
    ],
  })
  return mount(HomePage, { global: { plugins: [router] } })
}

async function switchToBatch(wrapper) {
  await wrapper.find('[data-test=mode-batch]').trigger('click')
  await flushPromises()
}

async function fillRow(wrapper, i, values) {
  for (const [key, value] of Object.entries(values)) {
    await wrapper.find(`#bf-${i}-${key}`).setValue(String(value))
  }
}

async function submitBatch(wrapper) {
  await wrapper.find('.batch-form button[type=submit]').trigger('submit.prevent')
  await flushPromises()
}

function batchItem(id, over = {}) {
  return {
    id, voyage: 'V-B', hatch: '1H',
    tg: 25, ta: 20, rh: 70,
    gamma: 0.98, gamma_display: 0.98,
    td: 14.36, td_display: 14.36,
    delta: 10.64, delta_display: 10.64,
    verdict: 'allowed',
    formula: { gamma_line: 'g', td_line: 't', delta_line: 'd', rule_line: 'r' },
    created_at: '2026-09-13T00:00:00Z',
    ...over,
  }
}

describe('HomePage batch mode', () => {
  afterEach(() => vi.restoreAllMocks())

  it('starts in single mode and reveals the batch grid with one row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"items":[]}', { status: 200 }),
    )
    const w = mountPage()
    await flushPromises()

    expect(w.find('.single-form').exists()).toBe(true)
    expect(w.find('.batch-form').exists()).toBe(false)

    await switchToBatch(w)
    expect(w.findAll('[data-test=batch-row]')).toHaveLength(1)
    expect(w.find('.batch-form button[type=submit]').text()).toContain('一次提交 1 行')
  })

  it('adds rows (new lines inherit voyage/hatch) up to the 20-row cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"items":[]}', { status: 200 }),
    )
    const w = mountPage()
    await flushPromises()
    await switchToBatch(w)

    await fillRow(w, 0, { voyage: 'V-2026', hatch: '3H', tg: 25, ta: 20, rh: 70 })
    await w.find('[data-test=batch-add-row]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-test=batch-row]')).toHaveLength(2)
    // The fresh line inherits voyage/hatch but never the measured numbers.
    expect(w.find('#bf-1-voyage').element.value).toBe('V-2026')
    expect(w.find('#bf-1-hatch').element.value).toBe('3H')
    expect(w.find('#bf-1-tg').element.value).toBe('')

    // Grow to the cap; the add control then disables.
    for (let n = 0; n < 18; n++) {
      await w.find('[data-test=batch-add-row]').trigger('click')
    }
    expect(w.findAll('[data-test=batch-row]')).toHaveLength(20)
    expect(w.find('[data-test=batch-add-row]').attributes('disabled')).toBeDefined()
  })

  it('posts the ordered rows to the batch endpoint and renders ids/Δ/verdict per line', async () => {
    const rows = [
      { voyage: 'V-B', hatch: '1H', tg: 25, ta: 20, rh: 70 },
      { voyage: 'V-B', hatch: '2H', tg: 5, ta: 28, rh: 95 },
      { voyage: 'V-B', hatch: '1H', tg: 24, ta: 20, rh: 70 },
    ]
    const saved = [
      batchItem(10, { id: 10, hatch: '1H', delta: 10.64, delta_display: 10.64, verdict: 'allowed' }),
      batchItem(11, { id: 11, hatch: '2H', tg: 5, ta: 28, rh: 95, delta: -22, delta_display: -22, verdict: 'denied' }),
      batchItem(12, { id: 12, hatch: '1H', tg: 24, delta: 9.64, delta_display: 9.64, verdict: 'allowed' }),
    ]
    const postCalls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      if (init.method === 'POST') {
        postCalls.push({ url: String(url), body: JSON.parse(init.body) })
        return Promise.resolve(new Response(JSON.stringify({ count: 3, items: saved }), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [...saved].reverse() }), { status: 200 }))
    })

    const w = mountPage()
    await flushPromises()
    await switchToBatch(w)
    await w.find('[data-test=batch-add-row]').trigger('click')
    await w.find('[data-test=batch-add-row]').trigger('click')
    for (const [i, r] of rows.entries()) {
      await fillRow(w, i, r)
    }
    await submitBatch(w)

    expect(postCalls).toHaveLength(1)
    expect(postCalls[0].url).toMatch(/\/api\/assessments\/batch$/)
    expect(postCalls[0].body).toEqual({ measurements: rows })

    const resultRows = w.findAll('[data-test=batch-result-row]')
    expect(resultRows).toHaveLength(3)
    // Ordered by creation order with the assessment id, unrounded/display Δ
    // and the API verdict; the page does not recompute any of them.
    expect(resultRows[0].text()).toContain('#10')
    expect(resultRows[0].text()).toContain('10.64')
    expect(resultRows[0].text()).toContain('允许通风')
    expect(resultRows[1].text()).toContain('#11')
    expect(resultRows[1].text()).toContain('-22')
    expect(resultRows[1].text()).toContain('禁止通风')
    expect(resultRows[2].text()).toContain('#12')

    // History refreshed with the new records (newest first).
    const historyLinks = w.findAll('.history tbody tr').slice(0, 3)
    expect(historyLinks[0].text()).toContain('12')
  })

  it('blocks a locally invalid middle row, names it, keeps all inputs, and never POSTs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"items":[]}', { status: 200 }),
    )
    const w = mountPage()
    await flushPromises()
    await switchToBatch(w)
    await w.find('[data-test=batch-add-row]').trigger('click')
    await w.find('[data-test=batch-add-row]').trigger('click')

    await fillRow(w, 0, { voyage: 'V-B', hatch: '1H', tg: 25, ta: 20, rh: 70 })
    await fillRow(w, 1, { voyage: 'V-B', hatch: '1H', tg: 999, ta: 20, rh: 70 })
    await fillRow(w, 2, { voyage: 'V-B', hatch: '1H', tg: 26, ta: 20, rh: 70 })
    await submitBatch(w)

    // Only the initial GET list happened; no batch POST.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    const invalidRows = w.findAll('[data-test=batch-row].batch-row-invalid')
    expect(invalidRows).toHaveLength(1)
    expect(invalidRows[0].attributes('data-row')).toBe('2')
    expect(w.find('#berr-1-tg').text()).toContain('60.0')
    expect(w.find('#bf-1-tg').attributes('aria-invalid')).toBe('true')
    expect(w.find('[data-test=batch-banner]').text()).toContain('第 2 行')
    // Every input is retained.
    expect(w.find('#bf-0-tg').element.value).toBe('25')
    expect(w.find('#bf-1-tg').element.value).toBe('999')
    expect(w.find('#bf-2-tg').element.value).toBe('26')
    expect(w.find('[data-test=batch-result]').exists()).toBe(false)
  })

  it('renders a server 422 (row 2 tg) under that row while preserving all inputs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      if (init.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          error: '批量输入校验失败，整批未保存任何记录',
          rows: [{ row: 2, fields: [{ field: 'tg', code: 'out_of_range', message: '粮温 Tg必须在 -20.0 至 60.0 之间' }] }],
        }), { status: 422, headers: { 'Content-Type': 'application/json' } }))
      }
      return Promise.resolve(new Response('{"items":[]}', { status: 200 }))
    })

    const w = mountPage()
    await flushPromises()
    await switchToBatch(w)
    await w.find('[data-test=batch-add-row]').trigger('click')
    await fillRow(w, 0, { voyage: 'V-B', hatch: '1H', tg: 25, ta: 20, rh: 70 })
    await fillRow(w, 1, { voyage: 'V-B', hatch: '1H', tg: 24, ta: 20, rh: 70 })
    await submitBatch(w)

    expect(w.find('#berr-1-tg').text()).toBe('粮温 Tg必须在 -20.0 至 60.0 之间')
    expect(w.findAll('[data-test=batch-row].batch-row-invalid')[0].attributes('data-row')).toBe('2')
    expect(w.find('[data-test=batch-banner]').text()).toContain('整批未保存')
    // Inputs survive the rejection.
    expect(w.find('#bf-0-tg').element.value).toBe('25')
    expect(w.find('#bf-1-tg').element.value).toBe('24')
    expect(w.find('[data-test=batch-result]').exists()).toBe(false)
  })

  it('surfaces a non-422 failure as a banner without clearing the grid', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      if (init.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ error: 'measurements 不能为空：批量至少提交 1 行测量' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.resolve(new Response('{"items":[]}', { status: 200 }))
    })

    const w = mountPage()
    await flushPromises()
    await switchToBatch(w)
    await fillRow(w, 0, { voyage: 'V-B', hatch: '1H', tg: 25, ta: 20, rh: 70 })
    await submitBatch(w)

    expect(w.find('[data-test=batch-banner]').text()).toContain('不能为空')
    expect(w.find('#bf-0-voyage').element.value).toBe('V-B')
  })
})
