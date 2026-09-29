// Service Worker：收外部訊息（deid@1）、驗核准狀態、轉交 offscreen 做模型推論；也處理設定頁的內部訊息。

import { deidentify } from './deid.ts'
import { handleExternal, ModelNotReadyError, type HandlerDeps } from './handler.ts'
import type { Entity } from './ner.ts'
import type { ModelState } from './offscreen.ts'
import { Settings } from './settings.ts'

const config = __SERVICE__
const settings = new Settings(chrome.storage.local)
const OFFSCREEN_URL = 'offscreen.html'
// 側邊欄使用的代號格式，與 deid@1 呼叫端相同
const PSEUDONYM_STYLE = '〔{role}{letter}〕'

let creating: Promise<void> | undefined

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  })
  return contexts.length > 0
}

async function ensureOffscreen(): Promise<void> {
  // 建立中的文件已出現在 getContexts，但腳本可能還沒註冊訊息處理；先等建立完成
  if (creating) return creating
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
  if (creating) return { state: 'loading' }
  return Promise.race([
    // offscreen 腳本尚未就緒時 sendMessage 會失敗，視為載入中
    toOffscreen<{ state: ModelState; error?: string }>({ type: 'status' }).catch(() => ({ state: 'loading' as const })),
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

// 核准視窗：每個呼叫者同時最多一個，關掉後至少隔 30 秒才會因為再次呼叫而重新跳出
const approvalWindows = new Map<string, number>()
const lastAsked = new Map<string, number>()
const ASK_INTERVAL_MS = 30_000

async function askApproval(id: string): Promise<void> {
  const open = approvalWindows.get(id)
  if (open !== undefined) {
    const alive = await chrome.windows.get(open).then(() => true, () => false)
    if (alive) return void chrome.windows.update(open, { focused: true })
    approvalWindows.delete(id)
  }
  if (Date.now() - (lastAsked.get(id) ?? 0) < ASK_INTERVAL_MS) return
  lastAsked.set(id, Date.now())
  const w = await chrome.windows.create({ url: `approve.html?id=${id}`, type: 'popup', width: 440, height: 520, focused: true })
  if (w?.id !== undefined) approvalWindows.set(id, w.id)
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, w] of approvalWindows) if (w === windowId) approvalWindows.delete(id)
})

const deps: HandlerDeps = {
  config,
  isApproved: (id) => settings.isApproved(id),
  isDenied: (id) => settings.isDenied(id),
  addPending: (id, name) => settings.addPending(id, name),
  askApproval: (id) => void askApproval(id).catch(() => {}),
  userDictionary: () => settings.dictionary(),
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

// 本擴充功能自己的頁面（側邊欄、歡迎頁、設定頁、核准視窗）送來的內部訊息
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
  if (msg.type === 'deidentify') {
    // 側邊欄：人自己使用。只在記憶體處理，對照表由側邊欄保管（關閉即清除），這裡不保存
    ;(async () => {
      const texts = [{ id: 'panel', text: String(msg.text ?? '') }]
      if (texts[0]!.text.length > config.max_chars_per_request) throw new Error(`文字超過 ${config.max_chars_per_request} 字，請分段處理`)
      const entities = await recognizeTexts(texts)
      return deidentify({
        texts,
        entities,
        entityTypes: config.entity_types,
        dictionary: await settings.dictionary(),
        existingMapping: (msg.mapping ?? {}) as Record<string, string>,
        pseudonymStyle: PSEUDONYM_STYLE,
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

async function setup(): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  await updateBadge()
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pending_callers) void updateBadge()
})
chrome.runtime.onStartup.addListener(() => void setup())
chrome.runtime.onInstalled.addListener((details) => {
  void setup()
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // 第一次安裝：開歡迎頁，並立即開始載入模型
    void chrome.tabs.create({ url: 'welcome.html' })
    void ensureOffscreen().catch(() => {})
  }
})
