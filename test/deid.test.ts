import { describe, expect, it } from 'vitest'
import { codeFor, codeLetter, deidentify, isRelativeTime, protectedSpans, restore, type DeidInput } from '../src/deid.ts'
import type { Entity } from '../src/ner.ts'

const STYLE = '〔{role}{letter}〕'
const TYPES = ['PERSON', 'GPE', 'LOC', 'ORG', 'FAC', 'NORP', 'DATE', 'TIME']

/** 依原文字串找位置產生假實體。 */
function ents(text: string, list: [string, string, number?][]): Entity[] {
  let from = 0
  return list.map(([s, type, score = 0.99]) => {
    const start = text.indexOf(s, from)
    if (start < 0) throw new Error(`找不到 ${s}`)
    from = start + s.length
    return { start, end: start + s.length, type, score }
  })
}

function run(partial: Partial<DeidInput> & Pick<DeidInput, 'texts'>) {
  return deidentify({ entities: {}, entityTypes: TYPES, dictionary: [], existingMapping: {}, pseudonymStyle: STYLE, threshold: 0.7, ...partial })
}

describe('codeLetter／codeFor（與 flow-ext-repo rules.ts 相同規則）', () => {
  it('A…Z、AA、AB', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(codeLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA'])
  })

  it('依同 role 已用數量接續，既有代號不變', () => {
    const m = { 王小明: '〔人物A〕', '0912-345-678': '〔手機A〕' }
    expect(codeFor(m, '陳美華', '人物', STYLE)).toBe('〔人物B〕')
    expect(codeFor(m, '王小明', '人物', STYLE)).toBe('〔人物A〕')
    expect(codeFor(m, '台中', '地點', STYLE)).toBe('〔地點A〕')
  })

  it('數量與字母對不上時（有缺號）不產生重複代號', () => {
    const m = { 甲: '〔人物B〕' }
    expect(codeFor(m, '乙', '人物', STYLE)).toBe('〔人物C〕')
  })

  it('依 pseudonym_style 組字串', () => {
    expect(codeFor({}, '王小明', '人物', '[{role}-{letter}]')).toBe('[人物-A]')
  })
})

describe('deidentify', () => {
  it('每段 id 原樣回傳、順序不變，沒有實體的段落也要回', () => {
    const r = run({ texts: [{ id: '3:0', text: '甲' }, { id: '0:0', text: '' }, { id: '0:1', text: '乙' }] })
    expect(r.texts.map((t) => t.id)).toEqual(['3:0', '0:0', '0:1'])
    expect(r.texts.map((t) => t.text)).toEqual(['甲', '', '乙'])
  })

  it('替換模型實體並回傳完整對照表（既有＋新增）', () => {
    const text = '王小明在台中榮民總醫院就診，陳美華陪同。'
    const r = run({
      texts: [{ id: '0:0', text }],
      entities: { '0:0': ents(text, [['王小明', 'PERSON'], ['台中榮民總醫院', 'FAC'], ['陳美華', 'PERSON']]) },
      existingMapping: { 王小明: '〔人物A〕', '0912-345-678': '〔手機A〕' },
    })
    expect(r.texts[0]!.text).toBe('〔人物A〕在〔設施A〕就診，〔人物B〕陪同。')
    expect(r.mapping).toEqual({ 王小明: '〔人物A〕', '0912-345-678': '〔手機A〕', 台中榮民總醫院: '〔設施A〕', 陳美華: '〔人物B〕' })
    expect(r.counts).toEqual({ PERSON: 2, FAC: 1 })
  })

  it('既有代號〔…〕原樣保留，與之重疊的實體丟棄', () => {
    const text = '請撥〔手機A〕給王小明'
    const r = run({
      texts: [{ id: '0:0', text }],
      entities: { '0:0': [{ start: 2, end: 6, type: 'PERSON', score: 0.9 }, ...ents(text, [['王小明', 'PERSON']])] },
      existingMapping: { '0912-345-678': '〔手機A〕' },
    })
    expect(r.texts[0]!.text).toBe('請撥〔手機A〕給〔人物A〕')
    expect(protectedSpans(text, STYLE)).toEqual([{ start: 2, end: 7 }])
  })

  it('字典優先於模型、長詞優先，自訂類型直接當 role', () => {
    const text = '林醫師與林醫師娘討論病人阿土伯的狀況'
    const r = run({
      texts: [{ id: '0:0', text }],
      entities: { '0:0': ents(text, [['林醫師', 'PERSON', 0.5], ['阿土伯', 'PERSON']]) },
      dictionary: [
        { term: '林醫師', type: 'PERSON' },
        { term: '林醫師娘', type: 'PERSON' },
        { term: '阿土伯', type: '病人' },
      ],
    })
    expect(r.texts[0]!.text).toBe('〔人物A〕與〔人物B〕討論病人〔病人A〕的狀況')
    expect(r.counts).toEqual({ PERSON: 2, 病人: 1 })
    expect(r.low_confidence).toEqual([]) // 林醫師由字典命中，不算模型低信心
  })

  it('字典詞不跨越既有代號', () => {
    const text = '〔人物A〕'
    const r = run({ texts: [{ id: '0:0', text }], dictionary: [{ term: '人物', type: 'PERSON' }] })
    expect(r.texts[0]!.text).toBe('〔人物A〕')
  })

  it('低信心實體仍替換，位置是回傳文字中的代號位置', () => {
    const text = '今天王小明和陳美華來了'
    const r = run({
      texts: [{ id: '0:1', text }],
      entities: { '0:1': ents(text, [['王小明', 'PERSON', 0.95], ['陳美華', 'PERSON', 0.52]]) },
    })
    expect(r.texts[0]!.text).toBe('今天〔人物A〕和〔人物B〕來了')
    expect(r.low_confidence).toEqual([{ id: '0:1', start: 8, end: 13, type: 'PERSON', score: 0.52 }])
    expect(r.texts[0]!.text.slice(8, 13)).toBe('〔人物B〕')
  })

  it('門檻可調', () => {
    const text = '王小明'
    const r = run({ texts: [{ id: 'a', text }], entities: { a: ents(text, [['王小明', 'PERSON', 0.8]]) }, threshold: 0.9 })
    expect(r.low_confidence).toHaveLength(1)
  })

  it('只處理 entity_types 內的類型', () => {
    const text = '王小明於2023年3月5日就診'
    const r = run({
      texts: [{ id: 'a', text }],
      entities: { a: ents(text, [['王小明', 'PERSON'], ['2023年3月5日', 'DATE']]) },
      entityTypes: ['PERSON'],
    })
    expect(r.texts[0]!.text).toBe('〔人物A〕於2023年3月5日就診')
  })

  it('同一原文跨段、跨請求一致；模型漏掉的已知原文也會替換', () => {
    const a = '王小明今天回診'
    const b = '家屬說王小明睡不好'
    const first = run({ texts: [{ id: '0:0', text: a }, { id: '1:0', text: b }], entities: { '0:0': ents(a, [['王小明', 'PERSON']]) } })
    expect(first.texts.map((t) => t.text)).toEqual(['〔人物A〕今天回診', '家屬說〔人物A〕睡不好'])
    expect(first.counts).toEqual({ PERSON: 2 })

    const c = '王小明下週再來，陳美華陪同'
    const second = run({ texts: [{ id: '0:0', text: c }], entities: { '0:0': ents(c, [['陳美華', 'PERSON']]) }, existingMapping: first.mapping })
    expect(second.texts[0]!.text).toBe('〔人物A〕下週再來，〔人物B〕陪同')
  })

  it('單字元已知原文不做全文掃描（避免「林」誤中「森林」）', () => {
    const text = '林說森林很美'
    const r = run({ texts: [{ id: 'a', text }], entities: { a: [{ start: 0, end: 1, type: 'PERSON', score: 0.9 }] } })
    expect(r.texts[0]!.text).toBe('〔人物A〕說森林很美')
  })

  it('實體頭尾空白被去除，重疊實體只取第一個', () => {
    const text = 'A 王小明 B'
    const r = run({
      texts: [{ id: 'a', text }],
      entities: { a: [{ start: 1, end: 6, type: 'PERSON', score: 0.9 }, { start: 3, end: 5, type: 'PERSON', score: 0.9 }] },
    })
    expect(r.texts[0]!.text).toBe('A 〔人物A〕 B')
  })

  it('已知限制：實體被切在兩段之間時，各段分別處理，不跨段合併', () => {
    // 呼叫方依字數硬切，「王小明」被切成「王小」與「明」
    const a = '今天看診的是王小'
    const b = '明，情況穩定'
    const r = run({
      texts: [{ id: '0:0', text: a }, { id: '0:1', text: b }],
      entities: { '0:0': ents(a, [['王小', 'PERSON', 0.6]]), '0:1': [] },
    })
    expect(r.texts.map((t) => t.text)).toEqual(['今天看診的是〔人物A〕', '明，情況穩定'])
  })
})

describe('restore（側邊欄還原）', () => {
  it('代號換回原文，長代號優先', () => {
    const m = { 王小明: '〔人物A〕', 陳美華: '〔人物AA〕', 台中: '〔地點A〕' }
    expect(restore('〔人物A〕和〔人物AA〕在〔地點A〕，〔人物A〕先離開', m)).toBe('王小明和陳美華在台中，王小明先離開')
  })

  it('去識別化後再還原，得到原文', () => {
    const text = '王小明住在台中'
    const r = deidentify({
      texts: [{ id: 'a', text }],
      entities: { a: [{ start: 0, end: 3, type: 'PERSON', score: 0.9 }, { start: 5, end: 7, type: 'GPE', score: 0.9 }] },
      entityTypes: ['PERSON', 'GPE'],
      dictionary: [],
      existingMapping: {},
      pseudonymStyle: '〔{role}{letter}〕',
      threshold: 0.7,
    })
    expect(restore(r.texts[0]!.text, r.mapping)).toBe(text)
  })
})

describe('相對時間保留原樣', () => {
  it.each(['今天', '昨晚', '上週', '上個月', '去年', '明年', '這陣子', '三個月', '十年', '兩年半', '兩週後', '3天', '半年前', '六十二歲', '三個多月', '早上', '下午', '最近', '目前', '每天'])('%s 保留', (t) => {
    expect(isRelativeTime(t)).toBe(true)
  })

  it.each(['2023年3月5日', '三月五日', '2024年', '5月12日', '上午十點', '10:30', '民國112年', '週三上午', '十月', '三月', '5日', '2024年前'])('%s 替換', (t) => {
    expect(isRelativeTime(t)).toBe(false)
  })

  it('模型標成 DATE 的相對時間不替換，具體日期照常替換', () => {
    const text = '阿土伯今天血壓偏高，2023年3月5日回診'
    const r = run({
      texts: [{ id: 'a', text }],
      entities: { a: ents(text, [['今天', 'DATE'], ['2023年3月5日', 'DATE']]) },
      dictionary: [{ term: '阿土伯', type: '病人' }],
    })
    expect(r.texts[0]!.text).toBe('〔病人A〕今天血壓偏高，〔日期A〕回診')
    expect(r.counts).toEqual({ 病人: 1, DATE: 1 })
  })
})
