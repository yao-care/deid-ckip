// deid@1 外部訊息處理：驗證呼叫者與訊息、分派 ping／capabilities／deidentify。
// 不碰 chrome API：核准狀態、模型、門檻都由 deps 注入，方便測試。

import { deidentify } from './deid.ts'
import type { Entity } from './ner.ts'
import { EXTENSION_ID_RE } from './settings.ts'

export interface ServiceConfig {
  name: string
  version: string
  protocol: string
  extension_id: string
  entity_types: string[]
  max_chars_per_request: number
}

export type ErrorCode = 'MODEL_NOT_READY' | 'TOO_LARGE' | 'INVALID' | 'NOT_APPROVED' | 'INTERNAL'

export interface ErrorResponse {
  error: string
  code: ErrorCode
}

export class ModelNotReadyError extends Error {}

export interface HandlerDeps {
  config: ServiceConfig
  isApproved(id: string): Promise<boolean>
  isDenied(id: string): Promise<boolean>
  /** 記入待核准；回傳是否為第一次出現。 */
  addPending(id: string, name?: string): Promise<boolean>
  /** 未核准、未拒絕的呼叫者：請使用者核准（開啟核准視窗；重複跳出的節流由實作負責）。 */
  askApproval(id: string): void
  /** 使用者在設定頁建立的字典，與呼叫端送來的字典合併（呼叫端優先）。 */
  userDictionary(): Promise<{ term: string; type: string }[]>
  /** 模型是否已就緒（不可等待，ping 要在 3 秒內回覆）。 */
  modelReady(): Promise<boolean>
  /** 開始載入模型（不等待）。 */
  startLoading(): void
  /** 等模型載入後辨識各段；載入失敗丟 ModelNotReadyError。 */
  recognize(texts: { id: string; text: string }[]): Promise<Record<string, Entity[]>>
  threshold(): Promise<number>
}

const err = (code: ErrorCode, error: string): ErrorResponse => ({ error, code })

export const NOT_APPROVED_MESSAGE = '此擴充功能尚未獲准使用去識別化服務，請在跳出的 deid-ckip 視窗按「允許」後重試'
export const DENIED_MESSAGE = '使用者已拒絕此擴充功能使用去識別化服務，可到 deid-ckip 設定頁取消拒絕'

export async function handleExternal(msg: unknown, senderId: string | undefined, deps: HandlerDeps): Promise<unknown> {
  if (!senderId || !EXTENSION_ID_RE.test(senderId)) return err('INVALID', '不允許的呼叫者')
  if (!isObject(msg) || typeof msg.type !== 'string') return err('INVALID', '訊息格式不正確')
  const { config } = deps
  const approved = await deps.isApproved(senderId)
  const denied = !approved && (await deps.isDenied(senderId))
  if (!approved && !denied) {
    const name = typeof msg.caller_name === 'string' ? msg.caller_name : undefined
    await deps.addPending(senderId, name)
    deps.askApproval(senderId)
  }

  switch (msg.type) {
    case 'ping': {
      if (!approved) return { ok: true, protocol: config.protocol, version: config.version, ready: false, approved: false }
      const ready = await deps.modelReady()
      if (!ready) deps.startLoading()
      return { ok: true, protocol: config.protocol, version: config.version, ready, approved: true }
    }
    case 'capabilities':
      return { entity_types: config.entity_types, max_chars_per_request: config.max_chars_per_request }
    case 'deidentify': {
      if (!approved) return err('NOT_APPROVED', denied ? DENIED_MESSAGE : NOT_APPROVED_MESSAGE)
      const req = validateDeidentify(msg)
      if (typeof req === 'string') return err('INVALID', req)
      const tooLong = req.texts.find((t) => t.text.length > config.max_chars_per_request)
      if (tooLong) return err('TOO_LARGE', `第 ${tooLong.id} 段有 ${tooLong.text.length} 字，超過上限 ${config.max_chars_per_request}`)
      const modelTypes = req.entity_types.filter((t) => config.entity_types.includes(t))
      let entities: Record<string, Entity[]> = {}
      if (modelTypes.length > 0) {
        try {
          entities = await deps.recognize(req.texts)
        } catch (e) {
          if (e instanceof ModelNotReadyError) return err('MODEL_NOT_READY', `模型無法載入：${e.message}`)
          throw e
        }
      }
      const own = new Set(req.dictionary.map((d) => d.term))
      const dictionary = [...req.dictionary, ...(await deps.userDictionary()).filter((d) => !own.has(d.term))]
      const out = deidentify({
        texts: req.texts,
        entities,
        entityTypes: modelTypes,
        dictionary,
        existingMapping: req.existing_mapping,
        pseudonymStyle: req.pseudonym_style,
        threshold: await deps.threshold(),
      })
      return { request_id: req.request_id, ...out }
    }
    default:
      return err('INVALID', `不支援的訊息類型：${msg.type}`)
  }
}

export interface DeidentifyRequest {
  request_id: string
  texts: { id: string; text: string }[]
  entity_types: string[]
  dictionary: { term: string; type: string }[]
  existing_mapping: Record<string, string>
  pseudonym_style: string
}

/** 驗證 deidentify 請求；不合法時回傳錯誤訊息字串。 */
export function validateDeidentify(m: Record<string, unknown>): DeidentifyRequest | string {
  if (typeof m.request_id !== 'string') return 'request_id 必須是字串'
  if (!Array.isArray(m.texts)) return 'texts 必須是陣列'
  const ids = new Set<string>()
  for (const t of m.texts) {
    if (!isObject(t) || typeof t.id !== 'string' || typeof t.text !== 'string') return 'texts 的每一項必須有字串 id 與 text'
    if (ids.has(t.id)) return `texts 的 id 重複：${t.id}`
    ids.add(t.id)
  }
  if (!Array.isArray(m.entity_types) || !m.entity_types.every((t) => typeof t === 'string')) return 'entity_types 必須是字串陣列'
  const dictionary = m.dictionary ?? []
  if (!Array.isArray(dictionary) || !dictionary.every((d) => isObject(d) && typeof d.term === 'string' && typeof d.type === 'string' && d.type !== ''))
    return 'dictionary 的每一項必須有字串 term 與 type'
  const mapping = m.existing_mapping ?? {}
  if (!isObject(mapping) || !Object.values(mapping).every((v) => typeof v === 'string')) return 'existing_mapping 必須是「原文 → 代號」的字串對照'
  const style = m.pseudonym_style
  if (typeof style !== 'string' || style.indexOf('{role}') < 0 || style.indexOf('{letter}') < style.indexOf('{role}'))
    return 'pseudonym_style 必須依序包含 {role} 與 {letter}'
  return {
    request_id: m.request_id,
    texts: m.texts as DeidentifyRequest['texts'],
    entity_types: m.entity_types as string[],
    dictionary: dictionary as DeidentifyRequest['dictionary'],
    existing_mapping: mapping as Record<string, string>,
    pseudonym_style: style,
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
