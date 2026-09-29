// pnpm build：service.yaml ＋ src/ ＋ models/ → dist/deid-ckip/ 與 dist/deid-ckip-<version>.zip。
// 環境變數 DEID_TEST_DELAY_MS：僅測試建置使用（辨識前人工延遲），輸出到 dist/deid-ckip-test/，不產生 zip。

import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { build } from 'esbuild'
import { zipSync } from 'fflate'
import type { ServiceConfig } from '../src/handler.ts'
import { readService, type ServiceYaml } from './service.ts'

const root = join(import.meta.dirname, '..')
const MODEL_FILES = ['model.onnx', 'vocab.txt', 'config.json']
const ORT_FILES = ['ort-wasm-simd-threaded.wasm']

export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'"

export function manifestOf(svc: ServiceYaml): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: svc.name,
    version: svc.version,
    description: svc.description,
    key: svc.extension.key,
    minimum_chrome_version: '116',
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ['offscreen', 'storage', 'sidePanel'],
    externally_connectable: { ids: ['*'] },
    action: { default_title: svc.name },
    side_panel: { default_path: 'sidepanel.html' },
    options_page: 'options.html',
    content_security_policy: { extension_pages: CSP },
  }
}

function checkModels(): void {
  const expected = JSON.parse(readFileSync(join(root, 'model-manifest.json'), 'utf8')) as { files: Record<string, string> }
  for (const f of MODEL_FILES) {
    const p = join(root, 'models', f)
    const want = expected.files[f]
    const got = existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : undefined
    if (!got || got !== want)
      throw new Error(`models/${f} ${got ? 'sha256 不符' : '不存在'}。請先執行：.venv/bin/python scripts/convert-model.py（見 README）`)
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? listFiles(p) : [p]
  })
}

async function main(): Promise<void> {
  const svc = readService(root)
  checkModels()
  const delay = Number(process.env.DEID_TEST_DELAY_MS ?? 0)
  const test = delay > 0
  const out = join(root, 'dist', test ? `${svc.id}-test` : svc.id)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const config: ServiceConfig = {
    name: svc.name,
    version: svc.version,
    protocol: svc.protocol,
    extension_id: svc.extension.id,
    entity_types: svc.entity_types,
    max_chars_per_request: svc.max_chars_per_request,
  }
  await build({
    entryPoints: ['background', 'offscreen', 'options', 'sidepanel', 'approve', 'welcome'].map((n) => join(root, 'src', `${n}.ts`)),
    outdir: out,
    bundle: true,
    format: 'esm',
    target: 'chrome116',
    minify: !test,
    legalComments: 'external',
    define: { __SERVICE__: JSON.stringify(config), __TEST_DELAY_MS__: String(delay) },
    logLevel: 'warning',
  })
  for (const f of ['offscreen.html', 'options.html', 'sidepanel.html', 'approve.html', 'welcome.html', 'ui.css']) copyFileSync(join(root, 'src', f), join(out, f))
  mkdirSync(join(out, 'models'))
  for (const f of MODEL_FILES) copyFileSync(join(root, 'models', f), join(out, 'models', f))
  mkdirSync(join(out, 'ort'))
  for (const f of ORT_FILES) copyFileSync(join(root, 'node_modules', 'onnxruntime-web', 'dist', f), join(out, 'ort', f))
  cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'))
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifestOf(svc), null, 2) + '\n')

  if (!test) {
    const files: Record<string, Uint8Array> = {}
    for (const p of listFiles(out)) files[relative(out, p)] = readFileSync(p)
    writeFileSync(join(root, 'dist', `${svc.id}-${svc.version}.zip`), zipSync(files, { level: 9 }))
  }
  console.log(`建置完成：${relative(root, out)}${test ? `（測試建置，延遲 ${delay} ms）` : `、dist/${svc.id}-${svc.version}.zip`}；擴充功能 ID ${svc.extension.id}`)
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
