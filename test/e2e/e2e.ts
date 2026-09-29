// 端對端：在 Chromium 同時載入 dist/deid-ckip 與測試呼叫端（test/e2e/caller/）。
//   pnpm e2e        安裝→歡迎頁、核准視窗、呼叫端去識別化、字典、側邊欄去識別化與還原（先 pnpm build）
//   pnpm e2e --shots 同上，並把各畫面截圖存到 docs/screenshots/
//   pnpm e2e:sw     Service Worker 存活實測（SPEC 5.3）：以延遲 150 秒的測試建置跑一次 deidentify
// 每一步都有逾時，整體上限見 LIMIT_MS。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { readService } from '../../scripts/service.ts'

const root = join(import.meta.dirname, '..', '..')
const svc = readService(root)
const swMode = process.argv.includes('--sw')
const DELAY_MS = 150_000
const LIMIT_MS = swMode ? 300_000 : 180_000
const dist = join(root, 'dist', swMode ? `${svc.id}-test` : svc.id)
const caller = join(root, 'test', 'e2e', 'caller')
const ID = svc.extension.id

const guard = setTimeout(() => {
  console.error(`超過整體上限 ${LIMIT_MS / 1000} 秒，中止`)
  process.exit(2)
}, LIMIT_MS)

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`失敗：${msg}`)
  console.log(`✓ ${msg}`)
}

async function callerId(ctx: BrowserContext): Promise<string> {
  const find = () => ctx.serviceWorkers().find((w) => !w.url().includes(ID))
  const sw = find() ?? (await ctx.waitForEvent('serviceworker', { predicate: (w) => !w.url().includes(ID), timeout: 10_000 }))
  return new URL(sw.url()).host
}

const call = (page: Page, msg: unknown, timeoutMs: number) =>
  page.evaluate(([id, m, t]) => (globalThis as any).callDeid(id, m, t), [ID, msg, timeoutMs] as const) as Promise<{ data?: any; reason?: string }>

const request = (texts: { id: string; text: string }[], existing: Record<string, string> = {}) => ({
  type: 'deidentify',
  request_id: `r_${Date.now()}`,
  texts,
  entity_types: ['PERSON', 'GPE', 'LOC', 'ORG', 'FAC', 'NORP', 'DATE', 'TIME'],
  dictionary: [{ term: '林醫師', type: 'PERSON' }],
  existing_mapping: existing,
  pseudonym_style: '〔{role}{letter}〕',
})

/** 其他擴充功能第一次呼叫時跳出的核准視窗，按「允許」。 */
async function approveInPopup(popup: Page): Promise<void> {
  await popup.waitForLoadState()
  await popup.setViewportSize({ width: 440, height: 520 })
  await shot(popup, '2-approve')
  await popup.getByRole('button', { name: '允許' }).click({ timeout: 10_000 })
  await popup.getByText('已允許').waitFor({ timeout: 5_000 })
}

const shots = join(root, 'docs', 'screenshots')
async function shot(page: Page, name: string): Promise<void> {
  if (process.argv.includes('--shots')) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true })
}

async function waitReady(page: Page): Promise<void> {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const r = await call(page, { type: 'ping' }, 3000)
    if (r.data?.ready) return
    await page.waitForTimeout(1000)
  }
  const opt = await page.context().newPage()
  await opt.goto(`chrome-extension://${ID}/options.html`)
  await opt.waitForTimeout(1500)
  const state = await opt.locator('#model-state').textContent()
  const error = await opt.locator('#model-error').textContent()
  throw new Error(`失敗：60 秒內模型沒有就緒（設定頁顯示：${state}；${error || '無錯誤訊息'}）`)
}

async function main(): Promise<void> {
  const userDir = mkdtempSync(join(tmpdir(), 'deid-e2e-'))
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist},${caller}`, `--load-extension=${dist},${caller}`],
  })
  try {
    const welcome = ctx.pages().find((p) => p.url().endsWith('/welcome.html')) ?? (await ctx.waitForEvent('page', { predicate: (p) => p.url().endsWith('/welcome.html'), timeout: 10_000 }))
    check(welcome, '第一次安裝自動開啟歡迎頁')
    await welcome.getByText('可以使用').waitFor({ timeout: 60_000 }).catch(async (e: unknown) => {
      throw new Error(`歡迎頁模型狀態：${await welcome.locator('#model-state').textContent()}；${await welcome.locator('#model-error').textContent()}（${e}）`)
    })
    check(true, '歡迎頁顯示模型「可以使用」')
    await welcome.setViewportSize({ width: 900, height: 900 })
    await shot(welcome, '1-welcome')

    const cid = await callerId(ctx)
    const page = await ctx.newPage()
    await page.goto(`chrome-extension://${cid}/caller.html`)

    const popupPromise = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/approve.html'), timeout: 10_000 })
    let r = await call(page, { type: 'ping', caller_name: 'deid-ckip 測試呼叫端' }, 3000)
    check(r.data?.ok && r.data.ready === false && r.data.approved === false, '未核准：ping 在 3 秒內回 ready: false、approved: false')
    const popup = await popupPromise
    check(popup.url().includes(`id=${cid}`), '第一次呼叫自動跳出核准視窗')
    r = await call(page, request([{ id: '0:0', text: '王小明' }]), 10_000)
    check(r.data?.code === 'NOT_APPROVED', '核准前 deidentify 回 NOT_APPROVED')
    await call(page, { type: 'ping' }, 3000)
    await page.waitForTimeout(1500)
    check(ctx.pages().filter((p) => p.url().includes('/approve.html')).length === 1, '同一個呼叫端重複呼叫，只會有一個核准視窗')

    await approveInPopup(popup)
    check(true, '在核准視窗按「允許」')
    await waitReady(page)
    check(true, '重試後 ping 回 ready: true')

    if (swMode) {
      // 模型已就緒後閒置 40 秒，讓 Service Worker 有機會進入閒置回收，再送出會延遲 150 秒的請求
      await page.waitForTimeout(40_000)
      const t0 = Date.now()
      r = await call(page, request([{ id: '0:0', text: '王小明今天回診。' }]), 170_000)
      const sec = Math.round((Date.now() - t0) / 1000)
      check(r.data?.texts?.[0]?.text?.includes('〔人物A〕'), `延遲 ${DELAY_MS / 1000} 秒的 deidentify 在 ${sec} 秒後仍收到正確回覆（Service Worker 沒有中途被回收）`)
      return
    }

    const text = '王小明於2023年3月5日在台中榮民總醫院就診，由林醫師看診，電話〔手機A〕。'
    r = await call(page, request([{ id: '0:0', text }, { id: '1:0', text: '' }], { '0912-345-678': '〔手機A〕' }), 120_000)
    const res = r.data
    check(res?.texts?.map((t: any) => t.id).join() === '0:0,1:0', 'deidentify 每段 id 原樣回傳')
    const out: string = res.texts[0].text
    console.log(`  ${out}`)
    for (const s of ['王小明', '2023年3月5日', '台中榮民總醫院', '林醫師']) check(!out.includes(s), `「${s}」已被替換`)
    check(out.includes('〔手機A〕') && res.mapping['0912-345-678'] === '〔手機A〕', '既有代號與對照保留')

    r = await call(page, request([{ id: '0:0', text: '家屬說王小明睡不好。' }], res.mapping), 120_000)
    check(r.data?.texts?.[0]?.text === `家屬說${res.mapping['王小明']}睡不好。`, '第二次呼叫帶 existing_mapping，同一人代號一致')

    r = await call(page, request([{ id: '0:0', text: 'x'.repeat(20001) }]), 10_000)
    check(r.data?.code === 'TOO_LARGE', '超過上限回 TOO_LARGE')

    // 設定頁：加入字典（補模型漏抓的「成大醫院」）
    const opt = await ctx.newPage()
    await opt.setViewportSize({ width: 900, height: 900 })
    await opt.goto(`chrome-extension://${ID}/options.html`)
    await opt.locator('#dict-term').fill('成大醫院')
    await opt.locator('#dict-form button[type=submit]').click()
    await opt.locator('#dictionary li', { hasText: '成大醫院' }).waitFor({ timeout: 5_000 })
    check(true, '設定頁加入字典詞「成大醫院」')
    await shot(opt, '4-options')

    // 側邊欄：人自己使用（以分頁開啟同一頁面）
    const panel = await ctx.newPage()
    await panel.setViewportSize({ width: 420, height: 1000 })
    await panel.goto(`chrome-extension://${ID}/sidepanel.html`)
    await panel.locator('#source').fill('王小明於2023年3月5日在台中榮民總醫院就診，之後轉到成大醫院追蹤。')
    await panel.getByRole('button', { name: '去識別化' }).click()
    await panel.locator('#result-section').waitFor({ state: 'visible', timeout: 60_000 })
    const deided = (await panel.locator('#result').textContent()) ?? ''
    console.log(`  ${deided}`)
    for (const s of ['王小明', '台中榮民總醫院', '成大醫院']) check(!deided.includes(s), `側邊欄：「${s}」已被替換`)
    const person = deided.match(/〔人物[A-Z]+〕/)?.[0] ?? ''
    await panel.locator('#reply').fill(`建議${person}三個月後回診。`)
    await panel.getByRole('button', { name: '還原' }).click()
    check((await panel.locator('#restored').textContent()) === '建議王小明三個月後回診。', '側邊欄：AI 回覆中的代號還原成原文')
    await shot(panel, '3-sidepanel')
  } finally {
    await ctx.close()
    rmSync(userDir, { recursive: true, force: true })
    clearTimeout(guard)
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
