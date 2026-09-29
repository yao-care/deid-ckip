// SPEC D5／8.1：不連網、不保存收到的文字。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../src/settings.ts'
import { CSP, manifestOf } from '../scripts/build.ts'
import { readService } from '../scripts/service.ts'
import { findEntities, harness, OTHER } from './helpers.ts'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const sources = readdirSync(SRC)
  .filter((f) => /\.(ts|html)$/.test(f))
  .map((f) => ({ file: f, code: readFileSync(join(SRC, f), 'utf8') }))

describe('靜態檢查：src/', () => {
  it.each(['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'http://', 'https://', 'chrome.cookies', 'chrome.identity'])('不含 %s', (word) => {
    expect(sources.filter((s) => s.code.includes(word)).map((s) => s.file)).toEqual([])
  })

  it('fetch 只用於讀取擴充功能自己的檔案', () => {
    for (const { file, code } of sources) {
      for (const m of code.matchAll(/\bfetch\s*\(/g)) {
        expect(`${file}: ${code.slice(m.index!, m.index! + 40)}`).toMatch(/fetch\(chrome\.runtime\.getURL\(/)
      }
    }
  })

  it('chrome.storage 的寫入只在 settings.ts', () => {
    const offenders = sources.filter((s) => s.file !== 'settings.ts' && /chrome\.storage\.\w+\.(set|remove|clear)\b|\.set\(\s*\{/.test(s.code))
    expect(offenders.map((s) => s.file)).toEqual([])
  })

  it('settings.ts 只寫入白名單內的鍵', () => {
    const code = readFileSync(join(SRC, 'settings.ts'), 'utf8')
    const written = [...code.matchAll(/this\.write\('([^']+)'/g)].map((m) => m[1])
    expect(written.length).toBeGreaterThan(0)
    for (const k of written) expect(STORAGE_KEYS).toContain(k)
    expect(code.match(/store\.set\(/g)).toHaveLength(1) // 唯一的寫入點是 write()
  })

  it('不使用 localStorage／sessionStorage／IndexedDB', () => {
    expect(sources.filter((s) => /localStorage|sessionStorage|indexedDB/.test(s.code)).map((s) => s.file)).toEqual([])
  })
})

describe('manifest', () => {
  const m = manifestOf(readService(ROOT)) as Record<string, any>

  it('不宣告 host_permissions，權限只有 offscreen 與 storage', () => {
    expect(m.host_permissions).toBeUndefined()
    expect(m.permissions).toEqual(['offscreen', 'storage'])
  })

  it('externally_connectable 只開放擴充功能，不開放網頁', () => {
    expect(m.externally_connectable).toEqual({ ids: ['*'] })
  })

  it('CSP 禁止對外連線', () => {
    expect(m.content_security_policy.extension_pages).toBe(CSP)
    expect(CSP).toContain("connect-src 'self'")
    expect(CSP).toContain("default-src 'self'")
  })
})

describe('執行期：處理請求後，儲存內容不含任何收到的文字', () => {
  it('ping → 未核准 deidentify → 核准 → deidentify → 調門檻', async () => {
    const secrets = ['王小明', '陳美華', '台中榮民總醫院', '林醫師', '0912-345-678', '〔人物Z〕原文']
    const text = '王小明與陳美華在台中榮民總醫院見到林醫師，電話 0912-345-678。'
    const h = harness({
      approved: [],
      entities: (t) => ({ [t[0]!.id]: findEntities(t[0]!.text, [['王小明', 'PERSON'], ['陳美華', 'PERSON', 0.4], ['台中榮民總醫院', 'FAC']]) }),
    })
    const request = {
      type: 'deidentify',
      request_id: 'r_secret_request',
      texts: [{ id: '0:0', text }],
      entity_types: ['PERSON', 'FAC'],
      dictionary: [{ term: '林醫師', type: 'PERSON' }],
      existing_mapping: { '〔人物Z〕原文': '〔人物Z〕' },
      pseudonym_style: '〔{role}{letter}〕',
    }
    await h.call({ type: 'ping' }, OTHER)
    expect(await h.call(request, OTHER)).toHaveProperty('code', 'NOT_APPROVED')
    await h.settings.approve(OTHER)
    const r = await h.call(request, OTHER)
    expect(r.texts[0].text).not.toContain('王小明')
    await h.settings.setThreshold(0.8)

    const keys = new Set(h.storage.writes.flatMap((w) => Object.keys(w)))
    for (const k of keys) expect(STORAGE_KEYS).toContain(k)
    const dump = JSON.stringify(h.storage.writes) + JSON.stringify(h.storage.data)
    for (const s of [...secrets, 'r_secret_request']) expect(dump).not.toContain(s)
  })
})
