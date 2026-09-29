import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WordPieceTokenizer } from '../src/tokenizer.ts'

const VOCAB = new URL('../models/vocab.txt', import.meta.url)

describe('WordPieceTokenizer（小字彙）', () => {
  const tok = new WordPieceTokenizer(['[PAD]', '[UNK]', '[CLS]', '[SEP]', '王', '小', '明', 'un', '##aff', '##able', '，'].join('\n'))

  it('中文逐字切開並保留位移', () => {
    expect(tok.tokenize('王小明')).toEqual([
      { id: 4, start: 0, end: 1 },
      { id: 5, start: 1, end: 2 },
      { id: 6, start: 2, end: 3 },
    ])
  })

  it('WordPiece 最長比對', () => {
    expect(tok.tokenize('unaffable').map((t) => t.id)).toEqual([7, 8, 9])
  })

  it('找不到子詞時整個字為 [UNK]', () => {
    expect(tok.tokenize('unknown')).toEqual([{ id: 1, start: 0, end: 7 }])
  })

  it('標點獨立成 token，空白與控制字元被移除', () => {
    expect(tok.tokenize(' 王​，明 ')).toEqual([
      { id: 4, start: 1, end: 2 },
      { id: 10, start: 3, end: 4 },
      { id: 6, start: 4, end: 5 },
    ])
  })
})

describe.skipIf(!existsSync(VOCAB))('WordPieceTokenizer 與 HF BertTokenizerFast 一致（需要 models/）', () => {
  const tok = new WordPieceTokenizer(readFileSync(VOCAB, 'utf8'))
  const cases = JSON.parse(readFileSync(new URL('./fixtures/tokenizer-parity.json', import.meta.url), 'utf8')) as {
    text: string
    ids: number[]
    offsets: [number, number][]
  }[]

  it.each(cases.map((c) => [c.text.slice(0, 24), c] as const))('%s', (_, c) => {
    const got = tok.tokenize(c.text)
    expect(got.map((t) => t.id)).toEqual(c.ids)
    expect(got.map((t) => [t.start, t.end])).toEqual(c.offsets)
  })
})
