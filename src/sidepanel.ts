// 側邊欄：人自己使用。貼文字 → 去識別化 → 複製給 AI → 貼回 AI 回覆 → 還原。
// 對照表只存在這個頁面的記憶體，關閉側邊欄即清除；不寫入任何儲存。

import { restore, type DeidOutput, type Mapping } from './deid.ts'
import { Settings } from './settings.ts'
import { $, el, loadModel, toBackground, watchModel, type ModelStatus } from './ui.ts'

const settings = new Settings(chrome.storage.local)
let mapping: Mapping = {}

const pill = $('model-state')
function showModel(s: ModelStatus): void {
  const err = $('model-error')
  err.hidden = s.state !== 'failed'
  err.textContent = s.error ? `模型載入失敗：${s.error}` : ''
}

async function showPending(): Promise<void> {
  const n = (await settings.pending()).length
  const banner = $('pending-banner')
  banner.hidden = n === 0
  banner.replaceChildren(`有 ${n} 個擴充功能想使用去識別化，等待你核准。`, el('a', { href: 'options.html', target: '_blank', textContent: '前往核准' }))
}

function renderMapping(): void {
  const rows = Object.entries(mapping).map(([original, code]) => el('tr', {}, el('td', {}, code), el('td', {}, original)))
  $('mapping').replaceChildren(...rows)
  $('mapping-section').hidden = rows.length === 0
  $('restore-section').hidden = rows.length === 0
}

/** 把回傳文字依 low_confidence 位置切段，低信心的代號用 <mark> 標出。 */
function renderResult(r: DeidOutput): void {
  const text = r.texts[0]?.text ?? ''
  const marks = [...r.low_confidence].sort((a, b) => a.start - b.start)
  const parts: (Node | string)[] = []
  let at = 0
  for (const m of marks) {
    parts.push(text.slice(at, m.start), el('mark', { title: `${m.type}，信心 ${m.score}`, textContent: text.slice(m.start, m.end) }))
    at = m.end
  }
  parts.push(text.slice(at))
  $('result').replaceChildren(...parts)
  $('result').dataset.text = text
  $('low-note').hidden = marks.length === 0
  $('result-section').hidden = false
}

async function copy(text: string, note: HTMLElement): Promise<void> {
  await navigator.clipboard.writeText(text)
  note.hidden = false
  setTimeout(() => (note.hidden = true), 1500)
}

$('deid').addEventListener('click', async () => {
  const text = $<HTMLTextAreaElement>('source').value
  if (!text.trim()) return
  const button = $<HTMLButtonElement>('deid')
  const note = $('deid-note')
  button.disabled = true
  note.textContent = '處理中…'
  void watchModel(pill, showModel)
  try {
    const r = await toBackground<DeidOutput & { error?: string }>({ type: 'deidentify', text, mapping })
    if (r.error) throw new Error(r.error)
    mapping = r.mapping
    renderResult(r)
    renderMapping()
    const n = Object.values(r.counts).reduce((a, b) => a + b, 0)
    note.textContent = n ? `替換了 ${n} 處` : '沒有找到需要替換的內容'
  } catch (e) {
    note.textContent = `錯誤：${e instanceof Error ? e.message : String(e)}`
  } finally {
    button.disabled = false
    void watchModel(pill, showModel)
  }
})

$('copy-result').addEventListener('click', () => void copy($('result').dataset.text ?? '', $('copied-result')))

$('restore').addEventListener('click', () => {
  const out = restore($<HTMLTextAreaElement>('reply').value, mapping)
  const box = $('restored')
  box.textContent = out
  box.hidden = false
  $('copy-restored').hidden = false
})

$('copy-restored').addEventListener('click', () => void copy($('restored').textContent ?? '', $('copied-restored')))

$('clear').addEventListener('click', () => {
  mapping = {}
  for (const id of ['source', 'reply'] as const) $<HTMLTextAreaElement>(id).value = ''
  $('result-section').hidden = true
  $('restored').hidden = true
  $('copy-restored').hidden = true
  $('deid-note').textContent = ''
  renderMapping()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pending_callers) void showPending()
})

void showPending()
void loadModel(pill, showModel)
