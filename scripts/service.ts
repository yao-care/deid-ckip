// 讀取並驗證 service.yaml；由公鑰算擴充功能 ID（算法同 Chrome：SPKI DER 的 sha256 前 32 個 hex 字元對應 a–p）。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

export const ServiceYaml = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+(\.\d+){0,3}$/, 'Chrome 版本號只能是 1 到 4 段數字'),
  protocol: z.string().regex(/^[a-z]+@\d+$/),
  license: z.string().min(1),
  extension: z.object({
    id: z.string().regex(/^[a-p]{32}$/),
    key: z.string().min(100),
  }),
  model: z.object({
    source: z.string().min(1),
    format: z.literal('onnx'),
    quantize: z.enum(['none', 'int8']),
    tokenizer: z.string().min(1),
  }),
  entity_types: z.array(z.string().regex(/^[A-Z_]+$/)).min(1),
  max_chars_per_request: z.number().int().positive(),
})
export type ServiceYaml = z.infer<typeof ServiceYaml>

export function extensionIdFromDer(der: Buffer): string {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('')
}

export function readService(root: string): ServiceYaml {
  const file = join(root, 'service.yaml')
  const r = ServiceYaml.safeParse(parse(readFileSync(file, 'utf8')))
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.') || '(根)'}：${i.message}`)
    throw new Error(`${file} 格式錯誤：\n${lines.join('\n')}`)
  }
  const derived = extensionIdFromDer(Buffer.from(r.data.extension.key, 'base64'))
  if (derived !== r.data.extension.id)
    throw new Error(`${file}：extension.key 算出的 ID 是 ${derived}，與 extension.id（${r.data.extension.id}）不符。換金鑰請執行 pnpm key`)
  return r.data
}
