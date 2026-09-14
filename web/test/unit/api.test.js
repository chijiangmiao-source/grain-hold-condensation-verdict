import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAssessment,
  createBatchAssessments,
  createRobustnessCheck,
  getAssessment,
  getRobustnessCheck,
  getVoyageOverview,
  listAssessments,
} from '@/lib/api.js'

describe('api client', () => {
  afterEach(() => vi.restoreAllMocks())

  it('posts JSON and returns parsed 201 body', async () => {
    const payload = { voyage: 'V1', hatch: '2', tg: 25, ta: 20, rh: 70 }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 7, verdict: 'allowed', delta_display: 10.64 }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }),
    )

    const res = await createAssessment(payload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/^https?:\/\/[^/]+\/api\/assessments$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(payload)
    expect(res.status).toBe(201)
    expect(res.ok).toBe(true)
    expect(res.data.verdict).toBe('allowed')
  })

  it('surfaces 422 field errors without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        error: '输入校验失败，未生成任何记录',
        fields: [{ field: 'tg', code: 'out_of_range', message: '粮温 Tg必须在 -20.0 至 60.0 之间' }],
      }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await createAssessment({ voyage: 'v', hatch: 'h', tg: 99, ta: 20, rh: 70 })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(422)
    expect(res.data.fields[0].field).toBe('tg')
  })

  it('builds list and detail urls', async () => {
    const calls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      calls.push(String(url))
      return Promise.resolve(new Response('{"items":[]}', { status: 200 }))
    })
    await listAssessments()
    await getAssessment('42')
    expect(calls.map(String)).toEqual([
      expect.stringMatching(/\/api\/assessments$/),
      expect.stringMatching(/\/api\/assessments\/42$/),
    ])
  })

  it('builds the per-voyage overview url with an encoded voyage and returns grouped items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        voyage: 'V/A',
        items: [{ id: 9, hatch: '3H', verdict: 'allowed', delta: 10.64 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await getVoyageOverview('V/A')

    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/api\/voyages\/V%2FA\/hatches\/latest$/)
    expect(res.status).toBe(200)
    expect(res.data.items[0].id).toBe(9)
    expect(res.data.items[0].verdict).toBe('allowed')
  })

  it('posts an ordered measurements array to the batch endpoint and returns count + items', async () => {
    const payload = [
      { voyage: 'V1', hatch: '1H', tg: 25, ta: 20, rh: 70 },
      { voyage: 'V1', hatch: '2H', tg: 5, ta: 28, rh: 95 },
    ]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        count: 2,
        items: [
          { id: 10, voyage: 'V1', hatch: '1H', delta: 10.64, delta_display: 10.64, verdict: 'allowed' },
          { id: 11, voyage: 'V1', hatch: '2H', delta: -22, delta_display: -22, verdict: 'denied' },
        ],
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await createBatchAssessments(payload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/assessments\/batch$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ measurements: payload })
    expect(res.status).toBe(201)
    expect(res.data.count).toBe(2)
    expect(res.data.items.map((i) => i.id)).toEqual([10, 11])
  })

  it('surfaces a 422 batch rejection with per-row field errors without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        error: '批量输入校验失败，整批未保存任何记录',
        rows: [{ row: 2, fields: [{ field: 'tg', code: 'out_of_range', message: '粮温 Tg必须在 -20.0 至 60.0 之间' }] }],
      }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await createBatchAssessments([
      { voyage: 'v', hatch: 'h', tg: 25, ta: 20, rh: 70 },
      { voyage: 'v', hatch: 'h', tg: 999, ta: 20, rh: 70 },
    ])
    expect(res.ok).toBe(false)
    expect(res.status).toBe(422)
    expect(res.data.rows[0].row).toBe(2)
    expect(res.data.rows[0].fields[0].field).toBe('tg')
  })

  it('posts only the three symmetric tolerances to the check endpoint and is routed by assessment id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 3, status: 'stable', corners: [], verdicts: ['allowed'] }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }),
    )

    const res = await createRobustnessCheck(42, { tg_eps: 0.5, ta_eps: 0.5, rh_eps: 1 })
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/api\/assessments\/42\/robustness-checks$/)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ tg_eps: 0.5, ta_eps: 0.5, rh_eps: 1 })
    expect(res.status).toBe(201)
    expect(res.data.id).toBe(3)
  })

  it('surfaces the 422 field feedback of a rejected check without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        error: '稳健性核查输入校验失败，未生成任何记录',
        fields: [{ field: 'rh_eps', code: 'out_of_range', message: '越界' }],
      }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await createRobustnessCheck(1, { tg_eps: 0.5, ta_eps: 0.5, rh_eps: 999 })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(422)
    expect(res.data.fields[0].field).toBe('rh_eps')
  })

  it('builds the independent check-detail url by check id and renders server data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 9, assessment_id: 4, status: 'sensitive',
        verdicts: ['allowed', 'retest'], corners: [{ index: 1 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await getRobustnessCheck('9')
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/robustness-checks\/9$/)
    expect(res.status).toBe(200)
    expect(res.data.assessment_id).toBe(4)
    expect(res.data.verdictSet || res.data.verdicts).toEqual(['allowed', 'retest'])
  })
})
