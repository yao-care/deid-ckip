import { handleExternal, type HandlerDeps, type ServiceConfig } from '../src/handler.ts'
import type { Entity } from '../src/ner.ts'
import { Settings, type StorageLike } from '../src/settings.ts'

export const CALLER = 'abcdefghijklmnopabcdefghijklmnop'
export const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

export const CONFIG: ServiceConfig = {
  name: '去識別化（CKIP）',
  version: '0.1.0',
  protocol: 'deid@1',
  extension_id: 'fdchmnlidiijkhofoemcmpepibdnmgli',
  entity_types: ['PERSON', 'GPE', 'LOC', 'ORG', 'FAC', 'NORP', 'DATE', 'TIME'],
  max_chars_per_request: 20000,
}

/** 記憶體版 chrome.storage.local，記錄每次寫入。 */
export class MemoryStorage implements StorageLike {
  data: Record<string, unknown> = {}
  writes: Record<string, unknown>[] = []
  async get(keys: string[]) {
    return Object.fromEntries(keys.filter((k) => k in this.data).map((k) => [k, structuredClone(this.data[k])]))
  }
  async set(items: Record<string, unknown>) {
    this.writes.push(structuredClone(items))
    Object.assign(this.data, structuredClone(items))
  }
}

export interface Harness {
  storage: MemoryStorage
  settings: Settings
  deps: HandlerDeps
  loads: number
  call(msg: unknown, sender?: string): Promise<any>
}

/** 以假的 NER 建立 handler：entities 依段落 id 提供；model 可設為 'ready' | 'loading' | 'failed'。 */
export function harness(opts: { entities?: (texts: { id: string; text: string }[]) => Record<string, Entity[]>; model?: 'ready' | 'loading' | 'failed'; approved?: string[] } = {}): Harness {
  const storage = new MemoryStorage()
  const settings = new Settings(storage, () => 1759100000000)
  const h: Harness = {
    storage,
    settings,
    loads: 0,
    deps: {
      config: CONFIG,
      isApproved: (id) => settings.isApproved(id),
      addPending: async (id) => void (await settings.addPending(id)),
      modelReady: async () => (opts.model ?? 'ready') === 'ready',
      startLoading: () => void h.loads++,
      recognize: async (texts) => {
        if (opts.model === 'failed') {
          const { ModelNotReadyError } = await import('../src/handler.ts')
          throw new ModelNotReadyError('找不到 models/model.onnx')
        }
        return opts.entities?.(texts) ?? {}
      },
      threshold: () => settings.threshold(),
    },
    call: (msg, sender = CALLER) => handleExternal(msg, sender, h.deps),
  }
  storage.data.approved_callers = opts.approved ?? [CALLER]
  return h
}

/** 依原文字串找出所有出現位置，產生假實體。 */
export function findEntities(text: string, list: [string, string, number?][]): Entity[] {
  const out: Entity[] = []
  for (const [s, type, score = 0.99] of list) {
    for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + s.length)) out.push({ start: i, end: i + s.length, type, score })
  }
  return out.sort((a, b) => a.start - b.start)
}
