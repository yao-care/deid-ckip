// 唯一可以寫 chrome.storage 的模組。只存下列鍵，不存任何收到的文字（SPEC D5、8.1）。
// dictionary 是使用者在設定頁自己輸入的詞，不是收到的文字。

export const STORAGE_KEYS = ['threshold', 'approved_callers', 'pending_callers', 'denied_callers', 'dictionary'] as const
export type StorageKey = (typeof STORAGE_KEYS)[number]

export interface StorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface Pending {
  id: string
  first_seen: number
  /** 呼叫端自稱的名稱（訊息中的 caller_name，未經驗證）。 */
  name?: string
}

export interface DictEntry {
  term: string
  type: string
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

  denied(): Promise<string[]> {
    return this.read<string[]>('denied_callers', [])
  }

  async isDenied(id: string): Promise<boolean> {
    return (await this.denied()).includes(id)
  }

  /** 記下尚未核准的呼叫者（去重、只留最新 MAX_PENDING 筆；已拒絕的不記）。回傳是否為新加入。 */
  async addPending(id: string, name?: string): Promise<boolean> {
    if (!EXTENSION_ID_RE.test(id) || (await this.isDenied(id))) return false
    const list = await this.pending()
    if (list.some((p) => p.id === id)) return false
    const entry: Pending = { id, first_seen: this.now() }
    const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : ''
    if (clean) entry.name = clean
    await this.write('pending_callers', [...list, entry].slice(-MAX_PENDING))
    return true
  }

  async approve(id: string): Promise<void> {
    if (!EXTENSION_ID_RE.test(id)) throw new Error('擴充功能 ID 格式不正確')
    const list = await this.approved()
    if (!list.includes(id)) await this.write('approved_callers', [...list, id])
    await this.write('pending_callers', (await this.pending()).filter((p) => p.id !== id))
    const denied = await this.denied()
    if (denied.includes(id)) await this.write('denied_callers', denied.filter((d) => d !== id))
  }

  /** 拒絕：移出待核准並記住，之後不再跳出核准視窗（可在設定頁取消）。 */
  async reject(id: string): Promise<void> {
    if (!EXTENSION_ID_RE.test(id)) throw new Error('擴充功能 ID 格式不正確')
    await this.write('pending_callers', (await this.pending()).filter((p) => p.id !== id))
    const denied = await this.denied()
    if (!denied.includes(id)) await this.write('denied_callers', [...denied, id])
  }

  async undeny(id: string): Promise<void> {
    await this.write('denied_callers', (await this.denied()).filter((d) => d !== id))
  }

  dictionary(): Promise<DictEntry[]> {
    return this.read<DictEntry[]>('dictionary', [])
  }

  async addTerm(term: string, type: string): Promise<void> {
    const t = term.trim()
    const ty = type.trim()
    if (!t || !ty) throw new Error('詞與類型都不能空白')
    if (t.length > 100 || ty.length > 20) throw new Error('詞最多 100 字、類型最多 20 字')
    const list = (await this.dictionary()).filter((d) => d.term !== t)
    await this.write('dictionary', [...list, { term: t, type: ty }])
  }

  async removeTerm(term: string): Promise<void> {
    await this.write('dictionary', (await this.dictionary()).filter((d) => d.term !== term))
  }

  async revoke(id: string): Promise<void> {
    await this.write('approved_callers', (await this.approved()).filter((a) => a !== id))
  }
}
