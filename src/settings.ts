// 唯一可以寫 chrome.storage 的模組。只存下列三個鍵，不存任何收到的文字（SPEC D5、8.1）。

export const STORAGE_KEYS = ['threshold', 'approved_callers', 'pending_callers'] as const
export type StorageKey = (typeof STORAGE_KEYS)[number]

export interface StorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface Pending {
  id: string
  first_seen: number
}

export const DEFAULT_THRESHOLD = 0.7
export const MAX_PENDING = 20
export const EXTENSION_ID_RE = /^[a-p]{32}$/

export class Settings {
  constructor(private readonly store: StorageLike, private readonly now: () => number = Date.now) {}

  private async read<T>(key: StorageKey, fallback: T): Promise<T> {
    const r = await this.store.get([key])
    return (r[key] as T | undefined) ?? fallback
  }

  private write(key: StorageKey, value: unknown): Promise<void> {
    return this.store.set({ [key]: value })
  }

  async threshold(): Promise<number> {
    const t = await this.read<number>('threshold', DEFAULT_THRESHOLD)
    return typeof t === 'number' && t >= 0 && t <= 1 ? t : DEFAULT_THRESHOLD
  }

  async setThreshold(t: number): Promise<void> {
    if (!(typeof t === 'number' && t >= 0 && t <= 1)) throw new Error('信心門檻必須介於 0 與 1')
    await this.write('threshold', t)
  }

  approved(): Promise<string[]> {
    return this.read<string[]>('approved_callers', [])
  }

  pending(): Promise<Pending[]> {
    return this.read<Pending[]>('pending_callers', [])
  }

  async isApproved(id: string): Promise<boolean> {
    return (await this.approved()).includes(id)
  }

  /** 記下尚未核准的呼叫者（去重、只留最新 MAX_PENDING 筆）。回傳是否為新加入。 */
  async addPending(id: string): Promise<boolean> {
    if (!EXTENSION_ID_RE.test(id)) return false
    const list = await this.pending()
    if (list.some((p) => p.id === id)) return false
    await this.write('pending_callers', [...list, { id, first_seen: this.now() }].slice(-MAX_PENDING))
    return true
  }

  async approve(id: string): Promise<void> {
    if (!EXTENSION_ID_RE.test(id)) throw new Error('擴充功能 ID 格式不正確')
    const list = await this.approved()
    if (!list.includes(id)) await this.write('approved_callers', [...list, id])
    await this.write('pending_callers', (await this.pending()).filter((p) => p.id !== id))
  }

  async reject(id: string): Promise<void> {
    await this.write('pending_callers', (await this.pending()).filter((p) => p.id !== id))
  }

  async revoke(id: string): Promise<void> {
    await this.write('approved_callers', (await this.approved()).filter((a) => a !== id))
  }
}
