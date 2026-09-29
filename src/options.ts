// 設定頁：狀態、字典、其他擴充功能的核准／撤銷／取消拒絕、信心門檻。

import { ROLE } from './deid.ts'
import { Settings } from './settings.ts'
import { $, el, loadModel } from './ui.ts'

const config = __SERVICE__
const settings = new Settings(chrome.storage.local)

$('name').textContent = config.name
$('version').textContent = config.version
$('protocol').textContent = config.protocol
$('ext-id').textContent = chrome.runtime.id

void loadModel($('model-state'), (s) => {
  const err = $('model-error')
  err.hidden = s.state !== 'failed'
  err.textContent = s.error ? `模型載入失敗：${s.error}` : ''
})

type Action = [label: string, run: () => Promise<void>, secondary?: boolean]

function item(main: string, note: string, actions: Action[], mono = true): HTMLLIElement {
  const li = el('li', {}, el(mono ? 'code' : 'span', { className: 'id', textContent: main }))
  if (note) li.append(el('span', { className: 'muted', textContent: note }))
  for (const [label, run, secondary] of actions) {
    const b = el('button', { type: 'button', textContent: label, className: secondary ? 'secondary' : '' })
    b.addEventListener('click', () => void run())
    li.append(b)
  }
  return li
}

const empty = (text: string) => el('li', { className: 'empty', textContent: text })

async function renderCallers(): Promise<void> {
  const [pending, approved, denied] = await Promise.all([settings.pending(), settings.approved(), settings.denied()])
  $('pending').replaceChildren(
    ...(pending.length
      ? pending.map((p) =>
          item(p.id, `${p.name ? `自稱「${p.name}」，` : ''}首次呼叫：${new Date(p.first_seen).toLocaleString()}`, [
            ['允許', () => settings.approve(p.id)],
            ['拒絕', () => settings.reject(p.id), true],
          ]),
        )
      : [empty('沒有')]),
  )
  $('approved').replaceChildren(...(approved.length ? approved.map((id) => item(id, '', [['撤銷', () => settings.revoke(id), true]])) : [empty('沒有')]))
  $('denied').replaceChildren(...(denied.length ? denied.map((id) => item(id, '', [['取消拒絕', () => settings.undeny(id), true]])) : [empty('沒有')]))
}

async function renderDictionary(): Promise<void> {
  const list = await settings.dictionary()
  $('dictionary').replaceChildren(
    ...(list.length ? list.map((d) => item(d.term, ROLE[d.type] ?? d.type, [['刪除', () => settings.removeTerm(d.term), true]], false)) : [empty('尚未加入任何詞')]),
  )
}

const typeSelect = $<HTMLSelectElement>('dict-type')
const custom = $<HTMLInputElement>('dict-custom')
typeSelect.addEventListener('change', () => {
  custom.hidden = typeSelect.value !== '__custom'
  custom.required = !custom.hidden
})

$('dict-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('dict-error')
  try {
    const type = typeSelect.value === '__custom' ? custom.value : typeSelect.value
    await settings.addTerm($<HTMLInputElement>('dict-term').value, type)
    $<HTMLInputElement>('dict-term').value = ''
    err.hidden = true
  } catch (x) {
    err.hidden = false
    err.textContent = x instanceof Error ? x.message : String(x)
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.pending_callers || changes.approved_callers || changes.denied_callers) void renderCallers()
  if (changes.dictionary) void renderDictionary()
})

const thresholdInput = $<HTMLInputElement>('threshold')
$('threshold-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  await settings.setThreshold(Number(thresholdInput.value))
  const saved = $('threshold-saved')
  saved.hidden = false
  setTimeout(() => (saved.hidden = true), 1500)
})

void (async () => {
  thresholdInput.value = String(await settings.threshold())
  await Promise.all([renderCallers(), renderDictionary()])
})()
