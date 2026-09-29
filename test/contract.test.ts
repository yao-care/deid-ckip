// deid@1 契約 fixture（test/fixtures/contract/）：請求 → 預期回覆。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findEntities, harness } from './helpers.ts'

const DIR = join(import.meta.dirname, 'fixtures', 'contract')

interface Fixture {
  description: string
  entities: Record<string, [string, string, number?][]>
  request: Record<string, unknown>
  response: unknown
}

const expand = (x: unknown): unknown =>
  JSON.parse(JSON.stringify(x), (_, v) => {
    const m = typeof v === 'string' ? /^__REPEAT_(.)_(\d+)__$/.exec(v) : null
    return m ? m[1]!.repeat(Number(m[2])) : v
  })

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture] as const)

describe('deid@1 契約', () => {
  it('至少有 5 組 fixture', () => expect(fixtures.length).toBeGreaterThanOrEqual(5))

  it.each(fixtures)('%s', async (_, fx) => {
    const h = harness({ entities: (texts) => Object.fromEntries(texts.map((t) => [t.id, findEntities(t.text, fx.entities[t.id] ?? [])])) })
    expect(await h.call(expand(fx.request))).toEqual(fx.response)
  })
})
