import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import RobustnessCheckPage from '@/pages/RobustnessCheckPage.vue'

function corner(index, signs, values, verdict, matchesOriginal, over = {}) {
  return {
    index,
    tg_sign: signs[0], ta_sign: signs[1], rh_sign: signs[2],
    tg: values[0], ta: values[1], rh: values[2],
    gamma: 0.99, td: 14.4, delta: over.delta ?? 2.1,
    gamma_display: 0.99, td_display: 14.4, delta_display: over.delta_display ?? 2.1,
    verdict,
    matches_original: matchesOriginal,
    ...over,
  }
}

function stableCheck(over = {}) {
  return {
    id: 7, assessment_id: 6,
    assessment: {
      id: 6, voyage: 'V-9', hatch: '1P',
      tg: 25, ta: 20, rh: 70, td: 14.359183217771522, delta: 10.640816782228478,
      verdict: 'allowed',
    },
    tolerances: { tg: 0.5, ta: 0.5, rh: 1 },
    status: 'stable',
    verdicts: ['allowed'],
    corners: [
      corner(1, ['-', '-', '-'], [24.5, 19.5, 69], 'allowed', true, { delta: 10.841289, delta_display: 10.84 }),
      corner(2, ['-', '-', '+'], [24.5, 19.5, 71], 'allowed', true, { delta: 10.400736, delta_display: 10.4 }),
      corner(3, ['-', '+', '-'], [24.5, 20.5, 69], 'allowed', true, { delta: 9.88536, delta_display: 9.89 }),
      corner(4, ['-', '+', '+'], [24.5, 20.5, 71], 'allowed', true, { delta: 9.441518, delta_display: 9.44 }),
      corner(5, ['+', '-', '-'], [25.5, 19.5, 69], 'allowed', true, { delta: 11.841289, delta_display: 11.84 }),
      corner(6, ['+', '-', '+'], [25.5, 19.5, 71], 'allowed', true, { delta: 11.400736, delta_display: 11.4 }),
      corner(7, ['+', '+', '-'], [25.5, 20.5, 69], 'allowed', true, { delta: 10.88536, delta_display: 10.89 }),
      corner(8, ['+', '+', '+'], [25.5, 20.5, 71], 'allowed', true, { delta: 10.441518, delta_display: 10.44 }),
    ],
    created_at: '2026-09-14T08:00:00Z',
    ...over,
  }
}

function sensitiveCheck() {
  // Δ ≈ 2.0008 originally "allowed"; the four RH+ corners cross to retest.
  const c = stableCheck({
    assessment: {
      id: 9, voyage: 'V-X', hatch: '3H',
      tg: 16.36, ta: 20, rh: 70, td: 14.359183217771522, delta: 2.000816782228478,
      verdict: 'allowed',
    },
    assessment_id: 9,
    tolerances: { tg: 0.01, ta: 0.01, rh: 0.5 },
    status: 'sensitive',
    verdicts: ['allowed', 'retest'],
  })
  const retestDeltas = [1.890204, 1.871036, 1.910204, 1.891036]
  c.corners = [
    corner(1, ['-', '-', '-'], [16.35, 19.99, 69.5], 'allowed', true, { delta: 2.111276, delta_display: 2.11 }),
    corner(2, ['-', '-', '+'], [16.35, 19.99, 70.5], 'retest', false, { delta: retestDeltas[0], delta_display: 1.89 }),
    corner(3, ['-', '+', '-'], [16.35, 20.01, 69.5], 'allowed', true, { delta: 2.092141, delta_display: 2.09 }),
    corner(4, ['-', '+', '+'], [16.35, 20.01, 70.5], 'retest', false, { delta: retestDeltas[1], delta_display: 1.87 }),
    corner(5, ['+', '-', '-'], [16.37, 19.99, 69.5], 'allowed', true, { delta: 2.131276, delta_display: 2.13 }),
    corner(6, ['+', '-', '+'], [16.37, 19.99, 70.5], 'retest', false, { delta: retestDeltas[2], delta_display: 1.91 }),
    corner(7, ['+', '+', '-'], [16.37, 20.01, 69.5], 'allowed', true, { delta: 2.112141, delta_display: 2.11 }),
    corner(8, ['+', '+', '+'], [16.37, 20.01, 70.5], 'retest', false, { delta: retestDeltas[3], delta_display: 1.89 }),
  ]
  return c
}

function mountCheck(payload, status = 200) {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    }),
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { path: '/robustness-checks/:id', component: RobustnessCheckPage, props: true },
      { path: '/assessments/:id', component: { template: '<div/>' } },
    ],
  })
  const wrapper = mount(RobustnessCheckPage, {
    props: { id: '7' },
    global: { plugins: [router] },
  })
  return { wrapper, fetchMock }
}

describe('RobustnessCheckPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders a stable check: original snapshot, tolerances and all eight server corners verbatim', async () => {
    const payload = stableCheck()
    const { wrapper: w } = mountCheck(payload)
    await flushPromises()

    const detail = w.find('[data-test=check-detail]')
    expect(detail.exists()).toBe(true)
    expect(w.find('[data-test=check-status]').text()).toContain('稳定')
    expect(w.find('[data-test=risk-stable]').exists()).toBe(true)
    expect(w.find('[data-test=risk-sensitive]').exists()).toBe(false)

    // Original assessment snapshot (frozen at check creation).
    expect(detail.text()).toContain('V-9 / 1P')
    expect(detail.text()).toContain('10.640816782228478')
    expect(detail.text()).toContain('允许通风')

    // Tolerance ranges rendered around the original values.
    expect(detail.text()).toContain('±0.5')
    expect(detail.text()).toContain('24.50 ~ 25.50')
    expect(detail.text()).toContain('69.00 ~ 71.00')

    // Exactly eight rows, each a verbatim server corner; unrounded values shown.
    const rows = w.findAll('[data-test=corner-row]')
    expect(rows).toHaveLength(8)
    // The first corner is tg−/ta−/rh− and the last is +/+/+.
    const signCells = (row) => [row.findAll('td')[1].text(), row.findAll('td')[2].text(), row.findAll('td')[3].text()]
    expect(signCells(rows[0])).toEqual(['−', '−', '−'])
    expect(signCells(rows[7])).toEqual(['+', '+', '+'])
    expect(rows[0].text()).toContain('10.841289')
    expect(rows[7].text()).toContain('10.441518')
    expect(detail.text()).not.toContain('暂停并复测')
  })

  it('renders a sensitive check with the risk warning, the multi-verdict set, and four diverging rows', async () => {
    const { wrapper: w } = mountCheck(sensitiveCheck())
    await flushPromises()

    expect(w.find('[data-test=check-status]').text()).toContain('敏感')
    const risk = w.find('[data-test=risk-sensitive]')
    expect(risk.exists()).toBe(true)
    expect(risk.text()).toContain('4 组')
    expect(risk.text()).toContain('不得仅凭原结论操作')
    // Both verdicts of the server-provided set are shown as badges.
    expect(risk.text()).toContain('允许通风')
    expect(risk.text()).toContain('暂停并复测')

    const rows = w.findAll('[data-test=corner-row]')
    expect(rows).toHaveLength(8)
    const diverging = w.findAll('tr.corner-diverges')
    expect(diverging).toHaveLength(4)
    // Exactly the four RH+ rows (indices 2,4,6,8) diverge.
    for (const idx of [1, 3, 5, 7]) {
      expect(rows[idx].classes()).toContain('corner-diverges')
      expect(rows[idx].text()).toContain('暂停并复测')
    }
    for (const idx of [0, 2, 4, 6]) {
      expect(rows[idx].classes()).not.toContain('corner-diverges')
      expect(rows[idx].text()).toContain('允许通风')
    }
    // The unrounded retest deltas render verbatim from the server.
    expect(rows[1].text()).toContain('1.890204')
  })

  it('links back to the original assessment and requests by check id', async () => {
    const { wrapper: w, fetchMock } = mountCheck(stableCheck())
    await flushPromises()

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/robustness-checks\/7$/)
    const links = w.findAll('a').map((a) => a.attributes('href'))
    expect(links).toContain('/assessments/6')
  })

  it('on a missing check offers only the history entry, never a direct link back to the origin assessment', async () => {
    const { wrapper: w } = mountCheck({ error: '稳健性核查记录不存在' }, 404)
    await flushPromises()

    expect(w.find('[data-test=check-missing]').exists()).toBe(true)
    expect(w.find('[data-test=check-detail]').exists()).toBe(false)

    // The card's only action returns to history.
    const cardLinks = w.find('[data-test=check-missing]').findAll('a')
    expect(cardLinks.map((a) => a.attributes('href'))).toEqual(['/'])

    // Nothing on the page links straight back to the origin assessment in
    // this state: the origin id is unknown for an unreadable check.
    const allLinks = w.findAll('a').map((a) => a.attributes('href'))
    expect(allLinks.every((href) => !href.startsWith('/assessments/'))).toBe(true)
  })

  it('on a read failure offers only the history entry, never a direct link back to the origin assessment', async () => {
    const { wrapper: w } = mountCheck({ error: 'boom' }, 500)
    await flushPromises()

    expect(w.find('[data-test=check-error]').exists()).toBe(true)
    const cardLinks = w.find('[data-test=check-error]').findAll('a')
    expect(cardLinks.map((a) => a.attributes('href'))).toEqual(['/'])

    const allLinks = w.findAll('a').map((a) => a.attributes('href'))
    expect(allLinks.every((href) => !href.startsWith('/assessments/'))).toBe(true)
  })
})
