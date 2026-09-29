// 需要 models/（見 README 的模型轉換）。以 DEID_MODEL_TESTS=1 執行：pnpm test:model
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-web'
import { describe, expect, it } from 'vitest'
import { deidentify } from '../src/deid.ts'
import { createNerModel, type ModelConfig } from '../src/model.ts'
import { recognize, type NerModel } from '../src/ner.ts'

const ROOT = join(import.meta.dirname, '..')
const TYPES = ['PERSON', 'GPE', 'LOC', 'ORG', 'FAC', 'NORP', 'DATE', 'TIME']

describe.runIf(process.env.DEID_MODEL_TESTS === '1')('CKIP 模型（onnxruntime-web wasm）', () => {
  let model: NerModel
  const load = async () => {
    ort.env.wasm.numThreads = 1
    model ??= await createNerModel(ort, {
      model: readFileSync(join(ROOT, 'models', 'model.onnx')),
      vocab: readFileSync(join(ROOT, 'models', 'vocab.txt'), 'utf8'),
      config: JSON.parse(readFileSync(join(ROOT, 'models', 'config.json'), 'utf8')) as ModelConfig,
    })
    return model
  }

  it('短句：人名、日期、醫院', async () => {
    const text = '王小明於2023年3月5日在台中榮民總醫院就診，由林醫師看診。'
    const ents = await recognize(await load(), text)
    const got = ents.map((e) => [text.slice(e.start, e.end), e.type])
    expect(got).toEqual(expect.arrayContaining([['王小明', 'PERSON'], ['2023年3月5日', 'DATE'], ['台中榮民總醫院', 'FAC']]))
  })

  it('虛構門診紀錄：人名、醫院、縣市、日期都被替換，並回報數量', async () => {
    const text = readFileSync(join(ROOT, 'test', 'fixtures', 'samples', 'clinic-note.txt'), 'utf8')
    const entities = { '0:0': await recognize(await load(), text) }
    const r = deidentify({ texts: [{ id: '0:0', text }], entities, entityTypes: TYPES, dictionary: [], existingMapping: {}, pseudonymStyle: '〔{role}{letter}〕', threshold: 0.7 })
    const out = r.texts[0]!.text
    console.log(out, '\n', r.mapping, r.counts, r.low_confidence)
    for (const s of ['黃建國', '黃淑芬', '蔡承恩', '台南', '2024年5月12日', '奇美醫院', '阮綜合醫院']) expect(out).not.toContain(s)
    // 已知限制（README）：此模型在這段樣本中沒有辨識出「高雄」「成大醫院」，需要時請用字典補上
    expect(out).toContain('高雄')
    expect(r.counts.PERSON).toBeGreaterThanOrEqual(3)
    expect(r.counts.DATE).toBeGreaterThanOrEqual(1)
    expect(Object.keys(r.counts)).toEqual(expect.arrayContaining(['PERSON', 'GPE', 'DATE']))
  })

  it('20000 字的段落可在時限內完成（呼叫方逾時 120 秒）', async () => {
    const base = readFileSync(join(ROOT, 'test', 'fixtures', 'samples', 'clinic-note.txt'), 'utf8')
    const text = base.repeat(Math.ceil(20000 / base.length)).slice(0, 20000)
    const t0 = performance.now()
    const ents = await recognize(await load(), text)
    const ms = performance.now() - t0
    console.log(`20000 字：${ents.length} 個實體，${Math.round(ms)} ms`)
    expect(ms).toBeLessThan(60000)
  }, 120000)
})
