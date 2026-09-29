// pnpm key：讀本機 .keys/deid-ckip.pem（不進版控），算出公鑰與擴充功能 ID，寫回 service.yaml。
// 只有換金鑰時需要；一般建置只用 service.yaml 的公鑰。

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { extensionIdFromDer } from './service.ts'

const root = join(import.meta.dirname, '..')
const pem = join(root, '.keys', 'deid-ckip.pem')
if (!existsSync(pem)) {
  console.error(`找不到 ${pem}。產生新金鑰：openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out .keys/deid-ckip.pem（ID 會改變）`)
  process.exit(1)
}
const der = createPublicKey(createPrivateKey(readFileSync(pem))).export({ type: 'spki', format: 'der' }) as Buffer
const id = extensionIdFromDer(der)

const file = join(root, 'service.yaml')
const doc = parseDocument(readFileSync(file, 'utf8'))
const before = doc.getIn(['extension', 'id'])
doc.setIn(['extension', 'id'], id)
doc.setIn(['extension', 'key'], der.toString('base64'))
writeFileSync(file, doc.toString({ lineWidth: 0 }))
console.log(before === id ? `金鑰未變：擴充功能 ID ${id}` : `已更新 service.yaml：擴充功能 ID ${before} → ${id}`)
