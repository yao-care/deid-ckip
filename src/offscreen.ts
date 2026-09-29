// offscreen 文件：從擴充功能內的 models/ 載入模型並執行 NER。只回應 target: 'offscreen' 的內部訊息。

import * as ort from 'onnxruntime-web/wasm'
import { createNerModel, type ModelConfig } from './model.ts'
import { recognize, type Entity, type NerModel } from './ner.ts'

export type ModelState = 'idle' | 'loading' | 'ready' | 'failed'

// 只指定 .wasm 位置；給目錄字串會讓 ort 另外動態載入 .mjs 膠水檔（已打包在 offscreen.js 內）
ort.env.wasm.wasmPaths = { wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.wasm') }
// offscreen 文件沒有 cross-origin isolation，不能用多執行緒 wasm
ort.env.wasm.numThreads = 1

let state: ModelState = 'idle'
let failure = ''
let loading: Promise<NerModel> | undefined

// 只讀取擴充功能自己的檔案（chrome-extension://），CSP 的 connect-src 'self' 也禁止任何外部連線
const local = (path: string) => fetch(chrome.runtime.getURL(path))

function load(): Promise<NerModel> {
  loading ??= (async () => {
    state = 'loading'
    const [model, vocab, config] = await Promise.all([
      local('models/model.onnx').then((r) => r.arrayBuffer()),
      local('models/vocab.txt').then((r) => r.text()),
      local('models/config.json').then((r) => r.json() as Promise<ModelConfig>),
    ])
    return createNerModel(ort, { model: new Uint8Array(model), vocab, config })
  })().then(
    (m) => {
      state = 'ready'
      return m
    },
    (e: unknown) => {
      state = 'failed'
      failure = e instanceof Error ? e.message : String(e)
      throw e
    },
  )
  return loading
}

// 推論期間每 20 秒通知 Service Worker：Chrome 會回收閒置 30 秒的 SW，而 offscreen 送來的訊息會重置計時器。
// 等待 sendResponse 是否算活動，Chrome 文件沒有寫明，因此不依賴它（SPEC D10）。
const KEEPALIVE_MS = 20_000

async function recognizeAll(texts: { id: string; text: string }[]): Promise<Record<string, Entity[]>> {
  const timer = setInterval(() => chrome.runtime.sendMessage({ target: 'background', type: 'keepalive' }).catch(() => {}), KEEPALIVE_MS)
  try {
    const model = await load()
    if (__TEST_DELAY_MS__ > 0) await new Promise((r) => setTimeout(r, __TEST_DELAY_MS__))
    const out: Record<string, Entity[]> = {}
    for (const t of texts) out[t.id] = await recognize(model, t.text)
    return out
  } finally {
    clearInterval(timer)
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'offscreen') return
  if (msg.type === 'status') {
    sendResponse({ state, error: failure || undefined })
    return
  }
  if (msg.type === 'recognize') {
    recognizeAll(msg.texts).then(
      (entities) => sendResponse({ entities }),
      (e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e), model_failed: state === 'failed' }),
    )
    return true
  }
})

load().catch(() => {})
