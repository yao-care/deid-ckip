// 去識別化純邏輯：受保護代號、字典比對、模型實體合併、代號產生、替換。不碰 chrome API。

import type { Entity } from './ner.ts'

export type Mapping = Record<string, string>

export const ROLE: Record<string, string> = {
  PERSON: '人物',
  GPE: '地點',
  LOC: '地點',
  FAC: '設施',
  ORG: '機構',
  NORP: '族群',
  DATE: '日期',
  TIME: '時間',
}

export interface DeidInput {
  texts: { id: string; text: string }[]
  /** 各段的模型實體（依 texts 的 id）。 */
  entities: Record<string, Entity[]>
  entityTypes: string[]
  dictionary: { term: string; type: string }[]
  existingMapping: Mapping
  pseudonymStyle: string
  threshold: number
}

export interface DeidOutput {
  texts: { id: string; text: string }[]
  mapping: Mapping
  counts: Record<string, number>
  low_confidence: { id: string; start: number; end: number; type: string; score: number }[]
}

interface Span {
  start: number
  end: number
  type: string
  /** 只有模型實體有分數。 */
  score?: number
}

// 複製自 flow-ext-repo packages/privacy/src/rules.ts 的 codeLetter（2026-09-29），兩邊必須一致。
export function codeLetter(n: number): string {
  let s = ''
  n += 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 同 rules.ts 的 codeFor：以同一 role 已用代號數量決定字母；另外防止與既有代號相同。 */
export function codeFor(mapping: Mapping, original: string, role: string, style: string): string {
  const existing = mapping[original]
  if (existing) return existing
  const prefix = style.slice(0, style.indexOf('{role}')) + role
  const values = Object.values(mapping)
  const taken = new Set(values)
  let used = values.filter((c) => c.startsWith(prefix)).length
  let code = style.replace('{role}', role).replace('{letter}', codeLetter(used))
  while (taken.has(code)) code = style.replace('{role}', role).replace('{letter}', codeLetter(++used))
  mapping[original] = code
  return code
}

export function roleOf(type: string): string {
  return ROLE[type] ?? type
}

/** 代號格式的正規式：pseudonym_style 的 {role}{letter} 以外部分當作外框，例如〔…〕。 */
function protectedRe(style: string): RegExp {
  const open = style.slice(0, style.indexOf('{role}'))
  const close = style.slice(style.indexOf('{letter}') + '{letter}'.length)
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const inner = close ? `[^${esc(open)}${esc(close)}\\n]{1,40}` : '[^\\s]{1,40}'
  return new RegExp(`${esc(open)}${inner}${esc(close)}`, 'g')
}

export function protectedSpans(text: string, style: string): { start: number; end: number }[] {
  return [...text.matchAll(protectedRe(style))].map((m) => ({ start: m.index!, end: m.index! + m[0].length }))
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end

/** 由左而右、長詞優先比對，不與 blocked 區段重疊。 */
function matchTerms(text: string, terms: { term: string; type: string }[], blocked: { start: number; end: number }[]): Span[] {
  const sorted = terms.filter((t) => t.term.length > 0).sort((a, b) => b.term.length - a.term.length)
  const out: Span[] = []
  for (let i = 0; i < text.length; ) {
    const hit = sorted.find((t) => text.startsWith(t.term, i) && !blocked.some((b) => overlaps(b, { start: i, end: i + t.term.length })))
    if (hit) {
      out.push({ start: i, end: i + hit.term.length, type: hit.type })
      i += hit.term.length
    } else i++
  }
  return out
}

/** 已知原文再次出現時沿用代號；單字元不掃（例如「林」會誤中「森林」）。 */
const MIN_KNOWN_LEN = 2

export function deidentify(input: DeidInput): DeidOutput {
  const mapping: Mapping = { ...input.existingMapping }
  const allowed = new Set(input.entityTypes)
  const counts: Record<string, number> = {}
  const low: DeidOutput['low_confidence'] = []
  const typeOf = new Map<string, string>()

  // 第一輪：每段決定要替換的 span（字典 > 模型），並依出現順序配發代號
  const plans = input.texts.map(({ id, text }) => {
    const prot = protectedSpans(text, input.pseudonymStyle)
    const dict = matchTerms(text, input.dictionary, prot)
    const blocked = [...prot, ...dict]
    const model = (input.entities[id] ?? [])
      .filter((e) => allowed.has(e.type) && e.end > e.start && e.start >= 0 && e.end <= text.length)
      .map((e) => trim(text, e))
      .filter((e): e is Span => !!e && !blocked.some((b) => overlaps(b, e)))
      .sort((a, b) => a.start - b.start)
      .filter((e, k, arr) => k === 0 || e.start >= arr[k - 1]!.end)
    const spans = [...dict, ...model].sort((a, b) => a.start - b.start)
    for (const s of spans) {
      const original = text.slice(s.start, s.end)
      codeFor(mapping, original, roleOf(s.type), input.pseudonymStyle)
      if (!typeOf.has(original)) typeOf.set(original, s.type)
    }
    return { id, text, prot, spans }
  })

  // 第二輪：已知原文（既有＋本次新增）在其他位置出現也替換，確保一致
  const knownTerms = Object.keys(mapping)
    .filter((o) => o.length >= MIN_KNOWN_LEN)
    .map((o) => ({ term: o, type: typeOf.get(o) ?? typeFromCode(mapping[o]!, input.pseudonymStyle) }))

  const texts = plans.map(({ id, text, prot, spans }) => {
    const extra = matchTerms(text, knownTerms, [...prot, ...spans])
    const all = [...spans, ...extra].sort((a, b) => a.start - b.start)
    let out = ''
    let last = 0
    for (const s of all) {
      const code = mapping[text.slice(s.start, s.end)]!
      out += text.slice(last, s.start)
      const at = out.length
      out += code
      last = s.end
      counts[s.type] = (counts[s.type] ?? 0) + 1
      if (s.score !== undefined && s.score < input.threshold) low.push({ id, start: at, end: at + code.length, type: s.type, score: round(s.score) })
    }
    return { id, text: out + text.slice(last) }
  })

  return { texts, mapping, counts, low_confidence: low }
}

/** 去掉實體頭尾的空白；全為空白則捨棄。 */
function trim(text: string, e: Entity): Span | undefined {
  let { start, end } = e
  while (start < end && /\s/.test(text[start]!)) start++
  while (end > start && /\s/.test(text[end - 1]!)) end--
  return end > start ? { start, end, type: e.type, score: e.score } : undefined
}

/** 既有對照表只有代號沒有類型：由 role 反推（人物 → PERSON），不在表內的 role 直接當類型（例如 手機）。 */
function typeFromCode(code: string, style: string): string {
  const open = style.slice(0, style.indexOf('{role}'))
  const close = style.slice(style.indexOf('{letter}') + '{letter}'.length)
  const body = code.slice(code.startsWith(open) ? open.length : 0, close && code.endsWith(close) ? -close.length : undefined)
  const role = body.replace(/[A-Z]+$/, '')
  return Object.entries(ROLE).find(([, r]) => r === role)?.[0] ?? role
}

const round = (x: number) => Math.round(x * 1000) / 1000

/** 還原：把文字中的代號換回原文（長代號優先，避免〔人物A〕先吃掉〔人物AA〕的前綴）。 */
export function restore(text: string, mapping: Mapping): string {
  const back = Object.entries(mapping)
    .map(([original, code]) => ({ code, original }))
    .sort((a, b) => b.code.length - a.code.length)
  let out = text
  for (const { code, original } of back) out = out.split(code).join(original)
  return out
}
