import { describe, expect, it, vi, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import HomePage from '@/pages/HomePage.vue'

function mountPage() {
  return mount(HomePage, { global: { stubs: { RouterLink: true } } })
}

async function fill(wrapper, values) {
  for (const [key, value] of Object.entries(values)) {
    await wrapper.find(`#f-${key}`).setValue(value)
  }
}

async function submit(wrapper) {
  await wrapper.find('button').trigger('submit.prevent')
  await flushPromises()
}

const VALID = { voyage: 'V-1', hatch: '3H', tg: '25', ta: '20', rh: '70' }

describe('HomePage form', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows an inline error per out-of-range field and never calls POST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"items":[]}', { status: 200 }),
    )
    const w = mountPage()
    await flushPromises() // initial list load
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockClear()

    await fill(w, { voyage: 'V', hatch: 'H', tg: '60.5', ta: '20', rh: '120' })
    await submit(w)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(w.find('#err-tg').text()).toContain('60.0')
    expect(w.find('#err-rh').text()).toContain('100.0')
    expect(w.find('#f-tg').attributes('aria-invalid')).toBe('true')
  })

  it('rejects blank and out-of-range numeric input inline', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"items":[]}', { status: 200 }),
    )
    const w = mountPage()
    await flushPromises()

    await fill(w, { voyage: 'V', hatch: 'H', tg: '', ta: '-99', rh: '70' })
    await submit(w)

    expect(w.find('#err-tg').text()).toContain('必须填写')
    expect(w.find('#err-ta').text()).toContain('-20.0')
  })

  it('renders server 422 field errors under the matching fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      // POST -> 422 with a per-field error; GET list -> empty.
      if (init.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          error: '输入校验失败，未生成任何记录',
          fields: [{ field: 'tg', code: 'not_finite', message: '粮温 Tg必须为有限数值' }],
        }), { status: 422, headers: { 'Content-Type': 'application/json' } }))
      }
      return Promise.resolve(new Response('{"items":[]}', { status: 200 }))
    })
    const w = mountPage()
    await flushPromises()

    await fill(w, VALID)
    await submit(w)

    expect(w.find('#err-tg').text()).toBe('粮温 Tg必须为有限数值')
    expect(w.find('.banner-error').text()).toContain('未生成任何记录')
    expect(w.find('.result').exists()).toBe(false)
  })

  it('renders exactly the API values; verdict is not re-derived from rounded Δ', async () => {
    // delta_display looks like the boundary (2.00), yet the unrounded delta
    // is 2.004 and the API says allowed. The page must show "allowed".
    const apiRecord = {
      id: 3, voyage: 'V-1', hatch: '3H',
      tg: 25, ta: 20, rh: 70,
      gamma: 0.9826379171132591, gamma_display: 0.98,
      td: 14.359183217771522, td_display: 14.36,
      delta: 2.004, delta_display: 2.0,
      verdict: 'allowed',
      formula: { gamma_line: 'g', td_line: 't', delta_line: 'd', rule_line: 'r' },
      created_at: '2026-09-13T00:00:00Z',
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [apiRecord] }), { status: 200 }),
    )
    const w = mountPage()
    await flushPromises()

    const cells = w.findAll('tbody td').map((td) => td.text())
    expect(cells).toContain('2.00')
    expect(w.text()).toContain('允许通风')
    expect(w.text()).not.toContain('暂停并复测')
  })

  it('posts the parsed numeric form and shows the returned result on success', async () => {
    const created = {
      id: 11, voyage: 'V-1', hatch: '3H',
      tg: 25, ta: 20, rh: 70,
      gamma: 0.9826, gamma_display: 0.98,
      td: 14.3591, td_display: 14.36,
      delta: 10.6408, delta_display: 10.64,
      verdict: 'allowed',
      formula: { gamma_line: 'g', td_line: 't', delta_line: 'd', rule_line: 'r' },
      created_at: '2026-09-13T00:00:00Z',
    }
    const postCalls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      if (init.method === 'POST') {
        postCalls.push(JSON.parse(init.body))
        return Promise.resolve(new Response(JSON.stringify(created), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [created] }), { status: 200 }))
    })

    const w = mountPage()
    await flushPromises()
    await fill(w, VALID)
    await submit(w)

    expect(postCalls).toEqual([{ voyage: 'V-1', hatch: '3H', tg: 25, ta: 20, rh: 70 }])
    expect(w.find('.result').exists()).toBe(true)
    expect(w.find('.result').text()).toContain('10.64')
    expect(w.find('.result').text()).toContain('允许通风')
  })
})
