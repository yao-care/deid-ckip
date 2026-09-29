// 核准視窗：其他擴充功能第一次呼叫時由 background 開啟（approve.html?id=<擴充功能 ID>）。

import { EXTENSION_ID_RE, Settings } from './settings.ts'
import { $ } from './ui.ts'

const settings = new Settings(chrome.storage.local)
const id = new URLSearchParams(location.search).get('id') ?? ''

async function init(): Promise<void> {
  if (!EXTENSION_ID_RE.test(id)) {
    $('who').textContent = '擴充功能 ID 格式不正確'
    for (const b of ['allow', 'deny']) $<HTMLButtonElement>(b).disabled = true
    return
  }
  const entry = (await settings.pending()).find((p) => p.id === id)
  $('who').textContent = entry?.name ? `「${entry.name}」（名稱由對方提供，未經驗證）` : '一個擴充功能'
  $('caller-id').textContent = id
}

async function decide(allow: boolean): Promise<void> {
  if (allow) await settings.approve(id)
  else await settings.reject(id)
  for (const b of ['allow', 'deny']) $<HTMLButtonElement>(b).disabled = true
  const done = $('done')
  done.hidden = false
  done.textContent = allow ? '已允許。回到原本的擴充功能按「重試」即可。' : '已拒絕。之後不會再詢問；可在設定頁取消拒絕。'
  setTimeout(() => window.close(), 2500)
}

$('allow').addEventListener('click', () => void decide(true))
$('deny').addEventListener('click', () => void decide(false))
void init()
