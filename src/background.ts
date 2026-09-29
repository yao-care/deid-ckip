// Service Worker：收外部訊息（deid@1）、驗核准狀態、轉交 offscreen 做模型推論；也處理設定頁的內部訊息。

import { deidentify } from './deid.ts'
import { handleExternal, ModelNotReadyError, type HandlerDeps } from './handler.ts'
import type { Entity } from './ner.ts'
import type { ModelState } from './offscreen.ts'
import { Settings } from './settings.ts'

const config = __SERVICE__
const settings = new Settings(chrome.storage.local)
const OFFSCREEN_URL = 'offscreen.html'

let creating: Promise<void> | undefined

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  })
  return contexts.length > 0
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  creating ??= chrome.offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: [chrome.offscreen.Reason.WORKERS], justification: '在本機執行去識別化模型' })
    .finally(() => (creating = undefined))
  await creating
}

function toOffscreen<T>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg })
}

async function modelStatus(): Promise<{ state: ModelState; error?: string }> {
  if (!(await hasOffscreen())) return { state: 'idle' }
  return Promise.race([
    toOffscreen<{ state: ModelState; error?: string }>({ type: 'status' }),
    new Promise<{ state: ModelState }>((r) => setTimeout(() => r({ state: 'loading' }), 1000)),
  ])
}

async function recognizeTexts(texts: { id: string; text: string }[]): Promise<Record<string, Entity[]>> {
  await ensureOffscreen()
  const res = await toOffscreen<{ entities?: Record<string, Entity[]>; error?: string; model_failed?: boolean }>({ type: 'recognize', texts })
  if (res?.entities) return res.entities
  if (!res || res.model_failed) throw new ModelNotReadyError(res?.error ?? '沒有回應')
  throw new Error(res.error)
}

const deps: HandlerDeps = {
  config,
  isApproved: (id) => settings.isApproved(id),
  addPending: async (id) => void (await settings.addPending(id)),
  modelReady: async () => (await modelStatus()).state === 'ready',
  startLoading: () => void ensureOffscreen().catch(() => {}),
  recognize: recognizeTexts,
  threshold: () => settings.threshold(),
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  handleExternal(msg, sender.id, deps).then(sendResponse, (e: unknown) =>
    sendResponse({ error: `內部錯誤：${e instanceof Error ? e.message : String(e)}`, code: 'INTERNAL' }),
  )
  return true
})

// 設定頁的內部訊息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'background') return
  if (msg.type === 'keepalive') {
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'status') {
    modelStatus().then(sendResponse)
    return true
  }
  if (msg.type === 'load') {
    ensureOffscreen().then(() => sendResponse({ ok: true }), (e: unknown) => sendResponse({ error: String(e) }))
    return true
  }
  if (msg.type === 'test') {
    // 僅在記憶體處理，結果回給設定頁，不保存
    ;(async () => {
      const texts = [{ id: 'test', text: String(msg.text ?? '') }]
      const entities = await recognizeTexts(texts)
      return deidentify({
        texts,
        entities,
        entityTypes: config.entity_types,
        dictionary: [],
        existingMapping: {},
        pseudonymStyle: '〔{role}{letter}〕',
        threshold: await settings.threshold(),
      })
    })().then(sendResponse, (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) }))
    return true
  }
})

// 待核准徽章
async function updateBadge(): Promise<void> {
  const n = (await settings.pending()).length
  await chrome.action.setBadgeText({ text: n ? String(n) : '' })
  if (n) await chrome.action.setBadgeBackgroundColor({ color: '#b45309' })
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pending_callers) void updateBadge()
})
chrome.runtime.onStartup.addListener(() => void updateBadge())
chrome.runtime.onInstalled.addListener(() => void updateBadge())
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage())
