import { describe, expect, it } from 'vitest'
import { DENIED_MESSAGE, NOT_APPROVED_MESSAGE } from '../src/handler.ts'
import { MAX_PENDING } from '../src/settings.ts'
import { CALLER, findEntities, harness, OTHER } from './helpers.ts'

const req = (texts: { id: string; text: string }[], extra: Record<string, unknown> = {}) => ({
  type: 'deidentify',
  request_id: 'r_1759100000000',
  texts,
  entity_types: ['PERSON', 'GPE', 'LOC', 'ORG', 'FAC', 'NORP', 'DATE', 'TIME'],
  dictionary: [],
  existing_mapping: {},
  pseudonym_style: '〔{role}{letter}〕',
  ...extra,
})

describe('ping／capabilities', () => {
  it('ping 回協定、版本、就緒狀態', async () => {
    expect(await harness().call({ type: 'ping' })).toEqual({ ok: true, protocol: 'deid@1', version: '0.1.0', ready: true, approved: true })
  })

  it('模型未就緒時 ping 立即回 ready: false 並開始載入', async () => {
    const h = harness({ model: 'loading' })
    expect(await h.call({ type: 'ping' })).toMatchObject({ ok: true, ready: false })
    expect(h.loads).toBe(1)
  })

  it('capabilities 取自設定', async () => {
    expect(await harness().call({ type: 'capabilities' })).toEqual({
      entity_types: ['PERSON', 'GPE', 'LOC', 'ORG', 'FAC', 'NORP', 'DATE', 'TIME'],
      max_chars_per_request: 20000,
    })
  })
})

describe('呼叫者核准', () => {
  it('未核准：ping 回 ready/approved 為 false、不載入模型，並列入待核准', async () => {
    const h = harness()
    expect(await h.call({ type: 'ping' }, OTHER)).toEqual({ ok: true, protocol: 'deid@1', version: '0.1.0', ready: false, approved: false })
    expect(h.loads).toBe(0)
    expect(await h.settings.pending()).toEqual([{ id: OTHER, first_seen: 1759100000000 }])
  })

  it('未核准：deidentify 回 NOT_APPROVED；capabilities 照常回', async () => {
    const h = harness()
    expect(await h.call(req([{ id: '0:0', text: '王小明' }]), OTHER)).toEqual({ error: NOT_APPROVED_MESSAGE, code: 'NOT_APPROVED' })
    expect(await h.call({ type: 'capabilities' }, OTHER)).toHaveProperty('max_chars_per_request', 20000)
  })

  it('核准後放行、撤銷後再被拒', async () => {
    const h = harness({ approved: [] })
    await h.call({ type: 'ping' }, OTHER)
    await h.settings.approve(OTHER)
    expect(await h.settings.pending()).toEqual([])
    expect(await h.call(req([{ id: '0:0', text: '甲' }]), OTHER)).toHaveProperty('request_id')
    await h.settings.revoke(OTHER)
    expect(await h.call(req([{ id: '0:0', text: '甲' }]), OTHER)).toHaveProperty('code', 'NOT_APPROVED')
  })

  it('未核准的呼叫會請使用者核准，並記下呼叫端自稱的名稱', async () => {
    const h = harness({ approved: [] })
    await h.call({ type: 'ping', caller_name: '  research-evidence\u0007 ' }, OTHER)
    expect(h.asked).toEqual([OTHER])
    expect(await h.settings.pending()).toEqual([{ id: OTHER, first_seen: 1759100000000, name: 'research-evidence' }])
  })

  it('拒絕後記住：不再列入待核准、不再詢問，deidentify 回拒絕訊息；取消拒絕後恢復詢問', async () => {
    const h = harness({ approved: [] })
    await h.call({ type: 'ping' }, OTHER)
    await h.settings.reject(OTHER)
    h.asked.length = 0
    expect(await h.call({ type: 'ping' }, OTHER)).toMatchObject({ ready: false, approved: false })
    expect(await h.call(req([{ id: '0:0', text: '甲' }]), OTHER)).toEqual({ error: DENIED_MESSAGE, code: 'NOT_APPROVED' })
    expect(await h.settings.pending()).toEqual([])
    expect(h.asked).toEqual([])
    await h.settings.undeny(OTHER)
    await h.call({ type: 'ping' }, OTHER)
    expect(h.asked).toEqual([OTHER])
  })

  it('拒絕後改為允許，會從拒絕清單移除', async () => {
    const h = harness({ approved: [] })
    await h.settings.reject(OTHER)
    await h.settings.approve(OTHER)
    expect(await h.settings.denied()).toEqual([])
    expect(await h.call({ type: 'ping' }, OTHER)).toMatchObject({ approved: true })
  })

  it('待核准清單去重，最多保留最新 20 筆', async () => {
    const h = harness({ approved: [] })
    const ids = Array.from({ length: MAX_PENDING + 5 }, (_, i) => i.toString(16).padStart(32, '0').replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]!))
    for (const id of [...ids, ids[ids.length - 1]!]) await h.call({ type: 'ping' }, id)
    const pending = await h.settings.pending()
    expect(pending).toHaveLength(MAX_PENDING)
    expect(pending.map((p) => p.id)).toEqual(ids.slice(-MAX_PENDING))
  })

  it('sender.id 缺少或格式不符 → INVALID', async () => {
    const h = harness()
    expect(await h.call({ type: 'ping' }, '')).toEqual({ error: '不允許的呼叫者', code: 'INVALID' })
    expect(await h.call({ type: 'ping' }, 'https://evil.example')).toEqual({ error: '不允許的呼叫者', code: 'INVALID' })
    expect(await h.settings.pending()).toEqual([])
  })
})

describe('deidentify', () => {
  it('request_id 原樣回傳、每段都回', async () => {
    const h = harness({ entities: (t) => Object.fromEntries(t.map((x) => [x.id, findEntities(x.text, [['王小明', 'PERSON']])])) })
    const r = await h.call(req([{ id: '0:0', text: '王小明' }, { id: '0:1', text: '' }, { id: '3:0', text: '無' }]))
    expect(r.request_id).toBe('r_1759100000000')
    expect(r.texts).toEqual([{ id: '0:0', text: '〔人物A〕' }, { id: '0:1', text: '' }, { id: '3:0', text: '無' }])
  })

  it('任一段超過上限 → TOO_LARGE', async () => {
    const r = await harness().call(req([{ id: '0:0', text: '短' }, { id: '0:1', text: 'x'.repeat(20001) }]))
    expect(r).toEqual({ error: '第 0:1 段有 20001 字，超過上限 20000', code: 'TOO_LARGE' })
  })

  it.each([
    ['缺 request_id', { request_id: undefined }, 'request_id 必須是字串'],
    ['texts 不是陣列', { texts: 'x' }, 'texts 必須是陣列'],
    ['段落缺 text', { texts: [{ id: '0:0' }] }, 'texts 的每一項必須有字串 id 與 text'],
    ['段落 id 重複', { texts: [{ id: '0:0', text: 'a' }, { id: '0:0', text: 'b' }] }, 'texts 的 id 重複：0:0'],
    ['entity_types 錯', { entity_types: [1] }, 'entity_types 必須是字串陣列'],
    ['dictionary 錯', { dictionary: [{ term: '林' }] }, 'dictionary 的每一項必須有字串 term 與 type'],
    ['existing_mapping 錯', { existing_mapping: { a: 1 } }, 'existing_mapping 必須是「原文 → 代號」的字串對照'],
    ['pseudonym_style 錯', { pseudonym_style: '〔{letter}{role}〕' }, 'pseudonym_style 必須依序包含 {role} 與 {letter}'],
  ])('%s → INVALID', async (_, extra, message) => {
    expect(await harness().call(req([{ id: '0:0', text: 'a' }], extra))).toEqual({ error: message, code: 'INVALID' })
  })

  it('不支援的訊息類型、非物件訊息 → INVALID', async () => {
    const h = harness()
    expect(await h.call({ type: 'restore' })).toEqual({ error: '不支援的訊息類型：restore', code: 'INVALID' })
    expect(await h.call('ping')).toEqual({ error: '訊息格式不正確', code: 'INVALID' })
  })

  it('模型載入失敗 → MODEL_NOT_READY，不回傳未替換的原文', async () => {
    const r = await harness({ model: 'failed' }).call(req([{ id: '0:0', text: '王小明' }]))
    expect(r).toEqual({ error: '模型無法載入：找不到 models/model.onnx', code: 'MODEL_NOT_READY' })
  })

  it('entity_types 為空時只做字典，不需要模型', async () => {
    const r = await harness({ model: 'failed' }).call(req([{ id: '0:0', text: '林醫師來了' }], { entity_types: [], dictionary: [{ term: '林醫師', type: 'PERSON' }] }))
    expect(r.texts).toEqual([{ id: '0:0', text: '〔人物A〕來了' }])
  })

  it('使用者字典與呼叫端字典合併，同一詞以呼叫端為準', async () => {
    const h = harness()
    await h.settings.addTerm('成大醫院', 'ORG')
    await h.settings.addTerm('阿土伯', '病人')
    const r = await h.call(req([{ id: '0:0', text: '阿土伯在成大醫院' }], { dictionary: [{ term: '阿土伯', type: 'PERSON' }] }))
    expect(r.texts[0].text).toBe('〔人物A〕在〔機構A〕')
  })

  it('設定頁調整的門檻會套用', async () => {
    const h = harness({ entities: (t) => ({ [t[0]!.id]: findEntities(t[0]!.text, [['王小明', 'PERSON', 0.8]]) }) })
    expect((await h.call(req([{ id: '0:0', text: '王小明' }]))).low_confidence).toEqual([])
    await h.settings.setThreshold(0.9)
    expect((await h.call(req([{ id: '0:0', text: '王小明' }]))).low_confidence).toHaveLength(1)
  })
})
