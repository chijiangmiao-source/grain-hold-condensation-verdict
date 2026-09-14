import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import RobustnessLaunchPage from '@/pages/RobustnessLaunchPage.vue'

function originRecord(over = {}) {
  return {
    id: 6, voyage: 'V-9', hatch: '1P',
    tg: 25, ta: 20, rh: 70,
    gamma: 0.9826379171132591, td: 14.359183217771522, delta: 10.640816782228478,
    verdict: 'allowed',
    formula: { gamma_line: 'g', td_line: 't', delta_line: 'd', rule_line: 'r' },
    created_at: '2026-09-13T00:00:00Z',
    ...over,
  }
}

const routes = [
  { path: '/', component: { template: '<div/>' } },
  { path: '/assessments/:id/robustness-checks/new', component: RobustnessLaunchPage, props: true },
  { path: '/robustness-checks/:id', component: { template: '<div/>' } },
  { path: '/assessments/:id', component: { template: '<div/>' } },
]

function mountPage(fetchImpl) {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
  const router = createRouter({ history: createMemoryHistory(), routes })
  const wrapper = mount(RobustnessLaunchPage, {
    props: { id: '6' },
    global: { plugins: [router] },
  })
  return { wrapper, router, fetchMock }
}

async function fill(wrapper, values) {
  for (const [key, value] of Object.entries(values)) {
    await wrapper.find(`#rf-${key}`).setValue(value)
  }
}

async function submit(wrapper) {
  await wrapper.find('form[data-test=robustness-form]').trigger('submit.prevent')
  await flushPromises()
}

describe('RobustnessLaunchPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders the original assessment summary from the GET response', async () => {
    const { wrapper: w } = mountPage(() =>
      Promise.resolve(new Response(JSON.stringify(originRecord()), { status: 200 })))
    await flushPromises()

    const box = w.find('[data-test=origin-summary]')
    expect(box.exists()).toBe(true)
    expect(box.text()).toContain('#6')
    expect(box.text()).toContain('V-9 / 1P')
    expect(box.text()).toContain('允许通风')
    expect(box.text()).toContain('10.640816782228478')
  })

  it('posts the three symmetric magnitudes and navigates to the independent check detail by check number', async () => {
    const postBodies = []
    const { wrapper: w, router, fetchMock } = mountPage((url, init = {}) => {
      if (init.method === 'POST') {
        postBodies.push({ url: String(url), body: JSON.parse(init.body) })
        return Promise.resolve(new Response(JSON.stringify({ id: 77 }), { status: 201 }))
      }
      return Promise.resolve(new Response(JSON.stringify(originRecord()), { status: 200 }))
    })
    await flushPromises()
    await router.isReady()
    await fill(w, { tg_eps: '0.5', ta_eps: '0.5', rh_eps: '1' })
    await submit(w)

    expect(postBodies).toHaveLength(1)
    expect(postBodies[0].url).toMatch(/\/api\/assessments\/6\/robustness-checks$/)
    expect(postBodies[0].body).toEqual({ tg_eps: 0.5, ta_eps: 0.5, rh_eps: 1 })
    // Navigates BY CHECK NUMBER, never back to the assessment.
    expect(router.currentRoute.value.path).toBe('/robustness-checks/77')
    fetchMock.mockClear()
  })

  it('blocks a non-positive or range-overflowing magnitude locally and never POSTs', async () => {
    let posted = false
    const { wrapper: w } = mountPage((url, init = {}) => {
      if (init.method === 'POST') posted = true
      return Promise.resolve(new Response(JSON.stringify(originRecord()), { status: 200 }))
    })
    await flushPromises()

    await fill(w, { tg_eps: '0', ta_eps: '0.5', rh_eps: '1' })
    await submit(w)
    expect(posted).toBe(false)
    expect(w.find('#rerr-tg_eps').text()).toContain('正数')

    // tg=25 ± 40 leaves the legal temperature interval on the + side.
    await fill(w, { tg_eps: '40', rh_eps: '1' })
    await submit(w)
    expect(posted).toBe(false)
    expect(w.find('#rerr-tg_eps').text()).toContain('合法区间')

    // rh=70 ± 70 reaches 0, below the 1% humidity floor.
    await fill(w, { tg_eps: '0.5', rh_eps: '70' })
    await submit(w)
    expect(posted).toBe(false)
    expect(w.find('#rerr-rh_eps').text()).toContain('合法区间')
  })

  it('renders server 422 field errors under the matching fields and keeps inputs', async () => {
    const { wrapper: w } = mountPage((url, init = {}) => {
      if (init.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          error: '稳健性核查输入校验失败，未生成任何记录',
          fields: [{ field: 'tg_eps', code: 'not_positive', message: '粮温 Tg 的对称误差幅度必须为正数' }],
        }), { status: 422 }))
      }
      return Promise.resolve(new Response(JSON.stringify(originRecord()), { status: 200 }))
    })
    await flushPromises()

    await fill(w, { tg_eps: '0.5', ta_eps: '0.5', rh_eps: '1' })
    await submit(w)

    expect(w.find('#rerr-tg_eps').text()).toContain('正数')
    expect(w.find('[data-test=robustness-banner]').text()).toContain('未生成任何记录')
    // The other inputs are preserved for correction.
    expect(w.find('#rf-ta_eps').element.value).toBe('0.5')
  })

  it('shows an explicit missing state when the origin assessment 404s', async () => {
    const { wrapper: w } = mountPage(() =>
      Promise.resolve(new Response(JSON.stringify({ error: '记录不存在' }), { status: 404 })))
    await flushPromises()
    expect(w.find('[data-test=origin-missing]').exists()).toBe(true)
    expect(w.find('[data-test=origin-summary]').exists()).toBe(false)
  })
})
