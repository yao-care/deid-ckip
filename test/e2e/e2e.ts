// 端對端：在 Chromium 同時載入 dist/deid-ckip 與測試呼叫端（test/e2e/caller/）。
//   pnpm e2e        核准流程＋去識別化（先 pnpm build）
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

async function approve(ctx: BrowserContext, callerExtId: string): Promise<void> {
  const opt = await ctx.newPage()
  await opt.goto(`chrome-extension://${ID}/options.html`)
  const row = opt.locator('#pending li', { hasText: callerExtId })
  await row.getByRole('button', { name: '允許' }).click({ timeout: 10_000 })
  await opt.locator('#approved li', { hasText: callerExtId }).waitFor({ timeout: 5_000 })
  await opt.close()
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
    const cid = await callerId(ctx)
    const page = await ctx.newPage()
    await page.goto(`chrome-extension://${cid}/caller.html`)

    let r = await call(page, { type: 'ping' }, 3000)
    check(r.data?.ok && r.data.ready === false && r.data.approved === false, '未核准：ping 在 3 秒內回 ready: false、approved: false')
    r = await call(page, request([{ id: '0:0', text: '王小明' }]), 10_000)
    check(r.data?.code === 'NOT_APPROVED', '未核准：deidentify 回 NOT_APPROVED')

    await approve(ctx, cid)
    check(true, '設定頁核准呼叫端')
    await waitReady(page)
    check(true, 'ping 回 ready: true（模型在 offscreen 載入完成）')

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
