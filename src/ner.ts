// NER：tokenize → 滑動視窗推論 → 限制轉移的 Viterbi 解碼 → BIES/BIO 標籤合併成實體 span（原文字元位置）。
// 推論函式由外部注入（offscreen 用 onnxruntime-web，測試用假函式或 Node 版 onnxruntime-web）。

import type { Token, WordPieceTokenizer } from './tokenizer.ts'

export interface Entity {
  start: number
  end: number
  type: string
  /** 實體內各 token 在解碼路徑上所選標籤的機率最小值。 */
  score: number
}

/** 一個視窗的推論：輸入 token id（含 [CLS]/[SEP]），回傳 [seq × labels] 的 logits（row-major）。 */
export type RunWindow = (ids: number[]) => Promise<Float32Array>

export interface NerModel {
  tokenizer: WordPieceTokenizer
  id2label: Record<string, string>
  maxLen: number
  run: RunWindow
}

const STRIDE_OVERLAP = 128

interface TokenPred {
  /** 各標籤機率（softmax 後）。 */
  probs: Float32Array
  /** 此 token 在所屬視窗中離邊界的距離，重疊區取離邊界較遠（上下文較完整）的預測。 */
  margin: number
}

export async function recognize(model: NerModel, text: string): Promise<Entity[]> {
  const tokens = model.tokenizer.tokenize(text)
  if (tokens.length === 0) return []
  const labels = Object.keys(model.id2label)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => model.id2label[k]!)
  const numLabels = labels.length
  const win = Math.max(1, model.maxLen - 2)
  const step = Math.max(1, win - STRIDE_OVERLAP)
  const preds: (TokenPred | undefined)[] = new Array(tokens.length)

  for (let s = 0; ; s += step) {
    const slice = tokens.slice(s, s + win)
    const ids = [model.tokenizer.clsId, ...slice.map((t) => t.id), model.tokenizer.sepId]
    const logits = await model.run(ids)
    if (logits.length !== ids.length * numLabels) throw new Error(`模型輸出大小不符：${logits.length}，預期 ${ids.length * numLabels}`)
    slice.forEach((_, k) => {
      const margin = Math.min(k, slice.length - 1 - k)
      const i = s + k
      const prev = preds[i]
      if (!prev || margin > prev.margin) preds[i] = { probs: softmax(logits.subarray((k + 1) * numLabels, (k + 2) * numLabels)), margin }
    })
    if (s + win >= tokens.length) break
  }
  const rows = preds.map((p) => p!.probs)
  const path = viterbi(rows, labels)
  return decode(
    tokens,
    path.map((j, i) => ({ label: labels[j]!, prob: rows[i]![j]! })),
  )
}

function softmax(row: Float32Array): Float32Array {
  let max = -Infinity
  for (const x of row) if (x > max) max = x
  const out = new Float32Array(row.length)
  let sum = 0
  for (let j = 0; j < row.length; j++) sum += out[j] = Math.exp(row[j]! - max)
  for (let j = 0; j < row.length; j++) out[j]! /= sum
  return out
}

/**
 * 限制轉移的 Viterbi：只允許合法的標籤序列（BIES：I/E 只能接在同類型的 B/I 之後，序列不能停在 B/I；
 * BIO：I 只能接在同類型的 B/I 之後）。逐 token 取最大值會出現「B B B E」「B-FAC I-ORG E-FAC」這類不合法組合。
 */
export function viterbi(rows: Float32Array[], labels: string[]): number[] {
  const n = rows.length
  const L = labels.length
  const parsed = labels.map((l) => {
    const m = /^([BIES])-(.+)$/.exec(l)
    return m ? { tag: m[1]!, type: m[2]! } : { tag: 'O', type: '' }
  })
  const bies = parsed.some((p) => p.tag === 'E' || p.tag === 'S')
  const inside = (p: { tag: string }) => p.tag === 'B' || p.tag === 'I'
  const canStart = (j: number) => parsed[j]!.tag !== 'I' && parsed[j]!.tag !== 'E'
  const canFollow = (a: number, b: number) => {
    const x = parsed[a]!
    const y = parsed[b]!
    if (y.tag === 'I' || y.tag === 'E') return inside(x) && x.type === y.type
    return !bies || !inside(x)
  }
  const canEnd = (j: number) => !bies || !inside(parsed[j]!)
  const log = (x: number) => Math.log(Math.max(x, 1e-12))
  const prevs = labels.map((_, b) => labels.map((_, a) => a).filter((a) => canFollow(a, b)))

  let score = Float64Array.from({ length: L }, (_, j) => (canStart(j) ? log(rows[0]![j]!) : -Infinity))
  const back: Int16Array[] = []
  for (let i = 1; i < n; i++) {
    const next = new Float64Array(L).fill(-Infinity)
    const bp = new Int16Array(L)
    for (let b = 0; b < L; b++) {
      const e = log(rows[i]![b]!)
      for (const a of prevs[b]!) {
        if (score[a] === -Infinity) continue
        const v = score[a]! + e
        if (v > next[b]!) (next[b] = v), (bp[b] = a)
      }
    }
    back.push(bp)
    score = next
  }
  let best = -1
  for (let j = 0; j < L; j++) if (canEnd(j) && (best < 0 || score[j]! > score[best]!)) best = j
  const path = new Array<number>(n)
  path[n - 1] = best
  for (let i = n - 2; i >= 0; i--) path[i] = back[i]![path[i + 1]!]!
  return path
}

/** 標籤前綴：B/I/E/S（CKIP）或 B/I（BIO）。不合法的接續（例如 I 前面沒有 B）視為新實體開始。 */
export function decode(tokens: Token[], preds: { label: string; prob: number }[]): Entity[] {
  const out: Entity[] = []
  let cur: Entity | undefined
  const close = () => {
    if (cur) out.push(cur)
    cur = undefined
  }
  tokens.forEach((t, i) => {
    const { label, prob } = preds[i]!
    const m = /^([BIES])-(.+)$/.exec(label)
    if (!m) return close()
    const [, tag, type] = m as unknown as [string, string, string]
    const continues = cur && cur.type === type && (tag === 'I' || tag === 'E')
    if (continues) {
      cur!.end = t.end
      cur!.score = Math.min(cur!.score, prob)
    } else {
      close()
      cur = { start: t.start, end: t.end, type, score: prob }
    }
    if (tag === 'E' || tag === 'S') close()
  })
  close()
  return out
}
