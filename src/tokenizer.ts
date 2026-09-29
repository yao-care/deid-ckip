// BERT WordPiece tokenizer（對齊 HF BertTokenizerFast 的 bert-base-chinese 設定），附原文字元位移。
// 設定來源：models/config.json 的 do_lower_case；bert-base-chinese 為 false（不轉小寫、不去重音）。
// 位移為 JavaScript 字串索引（UTF-16），test/fixtures/tokenizer-parity.json 逐一比對 HF 的結果。

export interface Token {
  id: number
  /** 在原文中的起訖位置（UTF-16 索引，end 不含）。 */
  start: number
  end: number
}

const MAX_CHARS_PER_WORD = 100

const RE_OTHER = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}]/u
const RE_WHITESPACE = /\p{White_Space}/u
const RE_PUNCT = /\p{P}/u

function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false
  return RE_OTHER.test(ch)
}

function isWhitespace(ch: string): boolean {
  return ch === '\t' || ch === '\n' || ch === '\r' || RE_WHITESPACE.test(ch)
}

function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true
  return RE_PUNCT.test(ch)
}

function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>
  readonly unkId: number
  readonly clsId: number
  readonly sepId: number
  readonly padId: number

  constructor(vocabText: string, private readonly lowercase = false) {
    this.vocab = new Map()
    vocabText.split('\n').forEach((line, i) => {
      const t = line.replace(/\r$/, '')
      if (t !== '' && !this.vocab.has(t)) this.vocab.set(t, i)
    })
    const need = (t: string) => {
      const id = this.vocab.get(t)
      if (id === undefined) throw new Error(`vocab.txt 缺少 ${t}`)
      return id
    }
    this.unkId = need('[UNK]')
    this.clsId = need('[CLS]')
    this.sepId = need('[SEP]')
    this.padId = need('[PAD]')
  }

  /** 不加 [CLS]/[SEP] 的 token 序列。 */
  tokenize(text: string): Token[] {
    const out: Token[] = []
    for (const w of this.words(text)) this.wordPiece(w, out)
    return out
  }

  /** 正規化＋預切：回傳每個「字」（連續字元）與它在原文中各字元的位置。 */
  private *words(text: string): Generator<{ chars: string[]; pos: number[] }> {
    let chars: string[] = []
    let pos: number[] = []
    const flush = function* () {
      if (chars.length) yield { chars, pos }
      chars = []
      pos = []
    }
    let i = 0
    for (const raw of text) {
      const at = i
      i += raw.length
      if (raw === '\0' || raw === '�' || isControl(raw)) continue
      if (isWhitespace(raw)) {
        yield* flush()
        continue
      }
      const ch = this.lowercase ? raw.toLowerCase() : raw
      if (isChineseChar(raw.codePointAt(0)!) || isPunctuation(raw)) {
        yield* flush()
        chars = [ch]
        pos = [at]
        yield* flush()
        continue
      }
      chars.push(ch)
      pos.push(at)
    }
    yield* flush()
  }

  private wordPiece(w: { chars: string[]; pos: number[] }, out: Token[]): void {
    const n = w.chars.length
    const end = (k: number) => w.pos[k]! + w.chars[k]!.length
    if (n > MAX_CHARS_PER_WORD) {
      out.push({ id: this.unkId, start: w.pos[0]!, end: end(n - 1) })
      return
    }
    const pieces: Token[] = []
    let s = 0
    while (s < n) {
      let e = n
      let found: number | undefined
      while (s < e) {
        const sub = (s > 0 ? '##' : '') + w.chars.slice(s, e).join('')
        found = this.vocab.get(sub)
        if (found !== undefined) break
        e--
      }
      if (found === undefined) {
        out.push({ id: this.unkId, start: w.pos[0]!, end: end(n - 1) })
        return
      }
      pieces.push({ id: found, start: w.pos[s]!, end: end(e - 1) })
      s = e
    }
    out.push(...pieces)
  }
}
