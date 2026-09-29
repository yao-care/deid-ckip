// 各頁共用：取元素、送內部訊息、模型狀態顯示。

import type { ModelState } from './offscreen.ts'

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export const toBackground = <T>(msg: Record<string, unknown>): Promise<T> => chrome.runtime.sendMessage({ target: 'background', ...msg })

export const STATE_TEXT: Record<ModelState, string> = { idle: '未載入', loading: '載入中', ready: '可以使用', failed: '載入失敗' }

export interface ModelStatus {
  state: ModelState
  error?: string
}

/** 顯示模型狀態到 pill 元素（data-state 決定顏色）；載入中時每秒更新，直到就緒或失敗。 */
export async function watchModel(pill: HTMLElement, onChange?: (s: ModelStatus) => void): Promise<void> {
  const s = await toBackground<ModelStatus>({ type: 'status' }).catch((): ModelStatus => ({ state: 'loading' }))
  pill.textContent = STATE_TEXT[s.state]
  pill.dataset.state = s.state
  onChange?.(s)
  if (s.state === 'loading') setTimeout(() => void watchModel(pill, onChange), 1000)
}

export async function loadModel(pill: HTMLElement, onChange?: (s: ModelStatus) => void): Promise<void> {
  await toBackground({ type: 'load' })
  await watchModel(pill, onChange)
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}
