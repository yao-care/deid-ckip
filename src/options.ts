// 設定／狀態頁：模型狀態、呼叫者核准、信心門檻、本機測試。

import type { DeidOutput } from './deid.ts'
import type { ModelState } from './offscreen.ts'
import { Settings } from './settings.ts'

const config = __SERVICE__
const settings = new Settings(chrome.storage.local)
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const STATE_TEXT: Record<ModelState, string> = { idle: '未載入', loading: '載入中', ready: '就緒', failed: '失敗' }

const toBackground = <T>(msg: Record<string, unknown>): Promise<T> => chrome.runtime.sendMessage({ target: 'background', ...msg })

$('name').textContent = config.name
$('version').textContent = config.version
$('protocol').textContent = config.protocol
$('ext-id').textContent = chrome.runtime.id

async function refreshStatus(): Promise<ModelState> {
  const s = await toBackground<{ state: ModelState; error?: string }>({ type: 'status' })
  const pill = $('model-state')
  pill.textContent = STATE_TEXT[s.state]
  pill.dataset.state = s.state
  $<HTMLButtonElement>('load').hidden = s.state !== 'idle'
  const err = $('model-error')
  err.hidden = !s.error
  err.textContent = s.error ? `模型載入失敗：${s.error}` : ''
  return s.state
}

async function pollStatus(): Promise<void> {
  const state = await refreshStatus()
  if (state === 'loading') setTimeout(pollStatus, 1000)
}

$('load').addEventListener('click', async () => {
  await toBackground({ type: 'load' })
  void pollStatus()
})

function item(id: string, note: string, actions: [string, () => Promise<void>, boolean?][]): HTMLLIElement {
  const li = document.createElement('li')
  const code = document.createElement('code')
  code.className = 'id'
  code.textContent = id
  li.append(code)
  if (note) {
    const span = document.createElement('span')
    span.className = 'muted'
    span.textContent = note
    li.append(span)
  }
  for (const [label, run, secondary] of actions) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    if (secondary) b.className = 'secondary'
    b.addEventListener('click', async () => {
      await run()
      await renderCallers()
    })
    li.append(b)
  }
  return li
}

function empty(text: string): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'empty'
  li.textContent = text
  return li
}

async function renderCallers(): Promise<void> {
  const pending = await settings.pending()
  const approved = await settings.approved()
  $('pending').replaceChildren(
    ...(pending.length
      ? pending.map((p) =>
          item(p.id, `首次呼叫：${new Date(p.first_seen).toLocaleString()}`, [
            ['允許', () => settings.approve(p.id)],
            ['拒絕', () => settings.reject(p.id), true],
          ]),
        )
      : [empty('沒有待核准的呼叫者')]),
  )
  $('approved').replaceChildren(
    ...(approved.length ? approved.map((id) => item(id, '', [['撤銷', () => settings.revoke(id), true]])) : [empty('尚未核准任何呼叫者')]),
  )
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.pending_callers || changes.approved_callers)) void renderCallers()
})

const thresholdInput = $<HTMLInputElement>('threshold')
$('threshold-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  await settings.setThreshold(Number(thresholdInput.value))
  const saved = $('threshold-saved')
  saved.hidden = false
  setTimeout(() => (saved.hidden = true), 1500)
})

$('test-run').addEventListener('click', async () => {
  const out = $('test-output')
  const button = $<HTMLButtonElement>('test-run')
  button.disabled = true
  out.hidden = false
  out.textContent = '處理中…（第一次需要載入模型）'
  void pollStatus()
  try {
    const r = await toBackground<DeidOutput & { error?: string }>({ type: 'test', text: $<HTMLTextAreaElement>('test-input').value })
    if (r.error) throw new Error(r.error)
    const lines = [r.texts[0]?.text ?? '', '', '對照表：', ...Object.entries(r.mapping).map(([o, c]) => `  ${c} ← ${o}`)]
    if (r.low_confidence.length) lines.push('', `信心不足：${r.low_confidence.map((l) => `${l.type} ${l.score}`).join('、')}`)
    out.textContent = lines.join('\n')
  } catch (e) {
    out.textContent = `錯誤：${e instanceof Error ? e.message : String(e)}`
  } finally {
    button.disabled = false
    void refreshStatus()
  }
})

void (async () => {
  thresholdInput.value = String(await settings.threshold())
  await renderCallers()
  await pollStatus()
})()
