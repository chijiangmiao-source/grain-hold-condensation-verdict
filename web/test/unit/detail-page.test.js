import { describe, expect, it, vi, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DetailPage from '@/pages/DetailPage.vue'

function record(over = {}) {
  return {
    id: 5, voyage: 'V-9', hatch: '1P',
    tg: 25, ta: 20, rh: 70,
    gamma: 0.9826379171132591, gamma_display: 0.98,
    td: 14.359183217771522, td_display: 14.36,
    delta: 10.640816782228478, delta_display: 10.64,
    verdict: 'allowed',
    formula: {
      gamma_line: 'γ = ln(70/100) + 17.62 × 20 / (243.12 + 20) = 0.982638（展示值 0.98）',
      td_line: 'Td = 243.12 × γ / (17.62 − γ) = 14.359183 ℃（展示值 14.36 ℃）',
      delta_line: 'Δ = Tg − Td = 25 − 14.359183 = 10.640817 ℃（展示值 10.64 ℃）',
      rule_line: '判定以未舍入 Δ 为准',
    },
    created_at: '2026-09-13T00:00:00Z',
    ...over,
  }
}

function mountWith(payload, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    }),
  )
  return mount(DetailPage, {
    props: { id: '5' },
    global: { stubs: { RouterLink: true } },
  })
}

describe('DetailPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists every substituted formula line verbatim from the API', async () => {
    const w = mountWith(record())
    await flushPromises()

    const text = w.text()
    expect(text).toContain('ln(70/100)')
    expect(text).toContain('17.62 × 20 / (243.12 + 20)')
    expect(text).toContain('243.12 × γ / (17.62 − γ)')
    expect(text).toContain('Δ = Tg − Td = 25 − 14.359183')
    expect(text).toContain('10.640816782228478') // unrounded persisted value
    expect(text).toContain('允许通风')
  })

  it('shows the verdict next to a boundary-looking rounded delta without recomputing', async () => {
    const w = mountWith(record({ delta: 2.004, delta_display: 2.0, verdict: 'allowed' }))
    await flushPromises()
    expect(w.text()).toContain('2.004')
    expect(w.text()).toContain('允许通风')
    expect(w.text()).not.toContain('暂停并复测')
  })

  it('handles 404', async () => {
    const w = mountWith({ error: '记录不存在' }, 404)
    await flushPromises()
    expect(w.text()).toContain('记录不存在')
  })
})
