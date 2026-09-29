import { describe, expect, it } from 'vitest'
import { decode, recognize, type NerModel } from '../src/ner.ts'
import { WordPieceTokenizer } from '../src/tokenizer.ts'

const LABELS = ['O', 'B-PERSON', 'I-PERSON', 'E-PERSON', 'S-PERSON', 'B-GPE', 'E-GPE']
const id2label = Object.fromEntries(LABELS.map((l, i) => [String(i), l]))
const tok = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 0, start: i, end: i + 1 }))
const p = (...labels: string[]) => labels.map((label) => ({ label, prob: 0.9 }))

describe('decode（BIES／BIO）', () => {
  it('B-I-E 與 S', () => {
    expect(decode(tok(5), p('B-PERSON', 'I-PERSON', 'E-PERSON', 'O', 'S-PERSON'))).toEqual([
      { start: 0, end: 3, type: 'PERSON', score: 0.9 },
      { start: 4, end: 5, type: 'PERSON', score: 0.9 },
    ])
  })

  it('BIO（沒有 E）也能合併', () => {
    expect(decode(tok(3), p('B-GPE', 'I-GPE', 'O'))).toEqual([{ start: 0, end: 2, type: 'GPE', score: 0.9 }])
  })

  it('不合法接續：I 前面沒有 B、類型改變 → 新實體', () => {
    expect(decode(tok(4), p('I-PERSON', 'E-PERSON', 'B-PERSON', 'E-GPE')).map((e) => [e.start, e.end, e.type])).toEqual([
      [0, 2, 'PERSON'],
      [2, 3, 'PERSON'],
      [3, 4, 'GPE'],
    ])
  })

  it('分數取實體內 token 機率的最小值', () => {
    const preds = [
      { label: 'B-PERSON', prob: 0.99 },
      { label: 'I-PERSON', prob: 0.41 },
      { label: 'E-PERSON', prob: 0.97 },
    ]
    expect(decode(tok(3), preds)[0]!.score).toBe(0.41)
  })
})

describe('recognize（滑動視窗）', () => {
  // 每個中文字一個 token；假模型：「王」→ B-PERSON、「明」→ E-PERSON、其他 → I-PERSON 若前一字是王，否則 O
  const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '王', '小', '明', '的'].join('\n')
  const tokenizer = new WordPieceTokenizer(vocab)
  function fakeModel(maxLen: number, seen: number[][]): NerModel {
    return {
      tokenizer,
      id2label,
      maxLen,
      async run(ids) {
        seen.push(ids)
        const out = new Float32Array(ids.length * LABELS.length)
        ids.forEach((id, i) => {
          const label = id === 4 ? 1 : id === 5 ? 2 : id === 6 ? 3 : 0
          out[i * LABELS.length + label] = 10
        })
        return out
      },
    }
  }

  it('長文切成多個視窗（含 [CLS]/[SEP]），實體位置對回原文', async () => {
    const text = '的'.repeat(300) + '王小明' + '的'.repeat(300)
    const seen: number[][] = []
    const ents = await recognize(fakeModel(256, seen), text)
    expect(ents).toEqual([{ start: 300, end: 303, type: 'PERSON', score: expect.closeTo(1, 3) }])
    expect(seen.length).toBeGreaterThan(1)
    for (const ids of seen) {
      expect(ids.length).toBeLessThanOrEqual(256)
      expect(ids[0]).toBe(2)
      expect(ids[ids.length - 1]).toBe(3)
    }
  })

  it('空字串不呼叫模型', async () => {
    const seen: number[][] = []
    expect(await recognize(fakeModel(512, seen), '   ')).toEqual([])
    expect(seen).toEqual([])
  })
})

describe('viterbi', () => {
  it('逐 token 最大值不合法時，選出合法路徑', async () => {
    const { viterbi } = await import('../src/ner.ts')
    const labels = ['O', 'B-DATE', 'I-DATE', 'E-DATE', 'S-DATE']
    const row = (...p: number[]) => Float32Array.from(p)
    // 逐 token 最大值：B B E → 不合法（B 後面接 B）
    const rows = [row(0.01, 0.9, 0.05, 0.01, 0.03), row(0.01, 0.5, 0.45, 0.01, 0.03), row(0.01, 0.01, 0.01, 0.95, 0.02)]
    expect(viterbi(rows, labels).map((j) => labels[j])).toEqual(['B-DATE', 'I-DATE', 'E-DATE'])
  })

  it('序列不停在 B/I', async () => {
    const { viterbi } = await import('../src/ner.ts')
    const labels = ['O', 'B-X', 'I-X', 'E-X', 'S-X']
    const rows = [Float32Array.from([0.1, 0.6, 0.1, 0.1, 0.1])]
    expect(labels[viterbi(rows, labels)[0]!]).not.toBe('B-X')
  })
})
