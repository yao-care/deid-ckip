# deid-ckip 開發規格

Chrome MV3「服務擴充功能」：用 CKIP 中文 NER 模型＋使用者字典，在本機把文字中的人名、地名、機構、日期等換成一致代號。以獨立 public repo 開發，呼叫端（`flow-ext-repo` 的 research-evidence、research-design 等）透過 deid@1 協定使用。

原始規格撰寫日期：2026-09-29（原為 `flow-ext-repo` ROADMAP 第 8 步）。本版於同日改寫為獨立 repo 版本，決策紀錄見第 0 節。

**本服務獨立運作**：deid@1 協定由本 repo 定義並維護（第 3 節、契約 fixture）；開發、測試、建置、發布都不依賴任何呼叫端專案。初版協定與 `flow-ext-repo` 現有呼叫端相容，日後修改協定時維持向下相容或升協定版本，但呼叫端要配合的事一律不列入本 repo 的完成條件。

---

## 0. 決策紀錄（2026-09-29）

| # | 議題 | 決定 |
|---|---|---|
| D1 | repo 形式 | 完全獨立的 public repo（本 repo），不放在 `flow-ext-repo/services/`。 |
| D2 | 擴充功能 ID | 由本 repo 決定並公布。私鑰 `.keys/deid-ckip.pem` 只在維護者本機（不進版控），公鑰與 ID 寫在 `service.yaml`。呼叫端向本 repo 取得 ID，不再自己用私鑰計算。沿用原 `flow-ext-repo/.keys/deid-ckip.pem`，ID 不變：`fdchmnlidiijkhofoemcmpepibdnmgli`。 |
| D3 | 誰可以呼叫 | 執行期由使用者核准：manifest 不限制擴充功能 ID，陌生呼叫者先被拒絕並列入「待核准」，使用者在設定頁按「允許」後才放行。取代原規格的 `allowed_callers` 靜態白名單。 |
| D4 | DATE／TIME | 服務照請求的 `entity_types` 替換。是否從呼叫端移除 DATE/TIME 由呼叫端決定（`flow-ext-repo` 的 `docs/PRIVACY.md` 與 `gate.ts` 目前不一致，列入第 12 節）。 |
| D5 | 「不保存原文」的驗證 | 鍵名白名單＋執行期測試（見 8.1）。 |
| D6 | 120 秒推論期間 SW 存活 | 先查 Chrome 文件並實測，確定會被回收才加保活機制（見 5.3）。 |
| D8 | 模型格式與解碼（實作時決定） | fp32 ONNX（int8 實測標籤一致率僅 88.5%）；tokenizer 以 TS 自行實作並與 HF 逐 token 比對；以限制轉移的 Viterbi 解碼 BIES，取代逐 token 最大值。 |
| D9 | 不連網的第二道防線 | CSP 加上 `default-src 'self'` 與 `connect-src 'self'`，由瀏覽器擋下任何對外連線。 |
| D10 | SW 存活 | Chrome 文件沒有寫明等待回覆期間是否算活動，Playwright 實測又可能因自動化連線而偏樂觀，因此加上保活：推論期間 offscreen 每 20 秒送訊息給 SW（文件寫明 offscreen 的訊息會重置閒置計時器）。`pnpm e2e:sw` 驗證延遲 150 秒的請求仍收到回覆。 |
| D7 | 獨立性 | 本 repo 的驗收只看本 repo 的測試與建置；呼叫端的相容測試、E2E、文件更新屬於呼叫端自己的工作（第 12 節僅供參考）。 |

## 1. 目標與範圍

- 接收其他擴充功能送來的文字，用 CKIP 中文 NER 模型＋使用者字典，把人名、地名、機構、日期等換成一致代號，回傳替換後文字與對照表。
- 沒有任務、沒有流程、沒有對話；只有一個設定／狀態頁（含呼叫者核准）。
- 完全在本機執行：**不連網、不保存收到的原文**。

不在範圍內：呼叫端的詢問卡片、對照表保存、還原（代號 → 原文）、紀錄事件。這些都已在 `flow-ext-repo` 的 `packages/privacy` 完成。

## 2. 參考資料（協定來源，位於 `flow-ext-repo`；非必要依賴）

以下檔案是 deid@1 初版的來源，實作時用來確認相容性；本 repo 不引用、不依賴它們。

1. `CLAUDE.md`（專案規則，特別是「不可違反」）
2. `docs/SERVICE_EXTENSIONS.md`（服務擴充功能與 deid@1 協定）
3. `docs/PRIVACY.md`（隱私閘門、何時詢問、代號規則、紀錄）
4. `packages/privacy/src/gate.ts`、`packages/privacy/src/rules.ts`（呼叫方實際怎麼用）
5. `packages/background/src/chrome.ts` 的 `chromeDeidClient`（實際送出的訊息與逾時）
6. `packages/pack-builder/src/keys.ts`（擴充功能 ID 的算法：公鑰 SPKI DER 的 sha256 前 32 個 hex 字元對應 a–p）

## 3. deid@1 協定（本 repo 定義；初版須與現有呼叫端相容）

### 3.1 傳輸

- 呼叫方用 `chrome.runtime.sendMessage(<deid-ckip 擴充功能 ID>, message, callback)`。
- 服務在背景 Service Worker 用 `chrome.runtime.onMessageExternal` 接收，**必須回傳 `true` 並以 `sendResponse` 非同步回覆**。
- 呼叫方的判斷：`chrome.runtime.lastError` → 視為「未安裝」；超過逾時 → 視為「無回應」。
- 逾時（呼叫方寫死）：`ping` 3 秒、`capabilities` 3 秒、`deidentify` **120 秒**。模型尚未載入時 `ping` 也要在 3 秒內回覆（回 `ready: false`），不可等模型。

### 3.2 訊息

**ping**

```json
{ "type": "ping" }
→ { "ok": true, "protocol": "deid@1", "version": "0.1.0", "ready": true, "approved": true }
```

- `ready: false`：模型載入中，或呼叫者尚未核准（見 3.4）。呼叫方會顯示「去識別化擴充功能沒有回應」卡片讓使用者重試，所以收到第一個 ping 時就要開始載入模型（見 5.3）。
- `approved`：本版新增欄位，呼叫方目前不讀取，不影響相容性；供呼叫方日後顯示「請到 deid-ckip 設定頁核准」。
- `version` 取 manifest 版本，呼叫方會寫進 `deid_applied` 紀錄。

**capabilities**

```json
{ "type": "capabilities" }
→ { "entity_types": ["PERSON","GPE","LOC","ORG","FAC","NORP","DATE","TIME"], "max_chars_per_request": 20000 }
```

- 呼叫方用 `max_chars_per_request` 決定切段長度（沒回時預設 20000）。
- 未核准的呼叫者也照常回覆（不含任何使用者資料）。

**deidentify**（呼叫方實際送出的內容，見 `gate.ts`）

```json
{
  "type": "deidentify",
  "request_id": "r_1759100000000",
  "texts": [{ "id": "0:0", "text": "…" }, { "id": "0:1", "text": "…" }, { "id": "3:0", "text": "…" }],
  "entity_types": ["PERSON","GPE","LOC","ORG","FAC","NORP","DATE","TIME"],
  "dictionary": [{ "term": "林醫師", "type": "PERSON" }],
  "existing_mapping": { "0912-345-678": "〔手機A〕", "王小明": "〔人物A〕" },
  "pseudonym_style": "〔{role}{letter}〕"
}
```

回覆：

```json
{
  "request_id": "r_1759100000000",
  "texts": [{ "id": "0:0", "text": "…〔人物A〕…" }, { "id": "0:1", "text": "…" }, { "id": "3:0", "text": "…" }],
  "mapping": { "0912-345-678": "〔手機A〕", "王小明": "〔人物A〕", "台中": "〔地點A〕" },
  "counts": { "PERSON": 1, "GPE": 1 },
  "low_confidence": [{ "id": "0:0", "start": 34, "end": 39, "type": "PERSON", "score": 0.52 }]
}
```

必須遵守：

1. **`texts` 的 `id` 原樣回傳、每一段都要回**（呼叫方用 `id` 的 `段:序號` 重組，缺段會讓文字消失）。
2. `request_id` 原樣回傳。
3. **`mapping` 回傳「existing_mapping ＋ 本次新增」的完整對照表**。呼叫方用 `Object.assign` 合併；既有的「原文 → 代號」**絕不可改**。
4. 同一原文在同一請求、以及跨請求（透過 `existing_mapping`）永遠同一代號。
5. 文字中**已經存在的代號**（`〔…〕` 包起來的字串，例如基本規則產生的 `〔手機A〕`、`〔EmailA〕`）必須原樣保留，不可再被辨識或切開。呼叫方是「先跑基本規則、再送服務」。
6. `counts`：本次**新替換的出現次數**，依實體類型計數（鍵為 entity type）。不記原文。
7. `low_confidence`：分數低於門檻（預設 0.7，可在設定頁調整）的實體。**仍然要替換**（保守），`start`/`end` 是它在「回傳文字」中的代號位置。呼叫方只要有任何一筆，就會停下來讓使用者確認或修正替換後的文字。
8. 只處理 `entity_types` 裡列出的類型；`dictionary` 的詞一律替換（完全比對、長詞優先），且字典命中優先於模型結果。
9. 錯誤：`{ "error": "訊息", "code": "MODEL_NOT_READY" | "TOO_LARGE" | "INVALID" | "NOT_APPROVED" | "INTERNAL" }`（`INTERNAL`：未預期的內部錯誤）。呼叫方會把 `error` 顯示為「去識別化服務錯誤：…」。
   - 任一段超過 `max_chars_per_request` → `TOO_LARGE`。
   - 模型尚未就緒 → 可以等模型載入完成再處理（在 120 秒內），真的載入失敗才回 `MODEL_NOT_READY`。
   - 呼叫者未核准 → `NOT_APPROVED`，`error` 為「此擴充功能尚未獲准使用去識別化服務，請到 deid-ckip 設定頁核准後重試」。
10. 呼叫方切段是依字數硬切，實體可能剛好被切在兩段之間。服務**不用**跨段合併；在測試中記錄這個已知限制即可（見第 11 節）。

### 3.3 代號格式（要與基本規則一致）

基本規則（`rules.ts` 的 `codeFor`）產生 `〔{中文標籤}{字母}〕`，字母為 A、B、…、Z、AA、AB…，依「同標籤已用數量」遞增。服務的代號必須用**同一套規則**，才不會撞號：

- `{letter}`：數 `existing_mapping`（加上本次已新增者）中以 `〔{role}` 開頭的代號數量，照 `codeFor` 的 `codeLetter` 產生下一個。把 `codeLetter`／`codeFor` 的邏輯複製進本 repo 的 `src/deid.ts`，並在註解標明來源檔與複製日期。
- `{role}` 依實體類型：

| entity type | role（中文標籤） |
|---|---|
| PERSON | 人物 |
| GPE | 地點 |
| LOC | 地點 |
| FAC | 設施 |
| ORG | 機構 |
| NORP | 族群 |
| DATE | 日期 |
| TIME | 時間 |

- 字典的 `type` 若是上表的 entity type，就用對應 role；若是其他中文字（例如使用者自訂 `病人`），就直接當 role（例如 `〔病人A〕`）。
- `pseudonym_style` 目前一律是 `〔{role}{letter}〕`；仍要依它組字串，不要寫死。

### 3.4 呼叫者核准（D3）

- manifest 的 `externally_connectable` 為 `{ "ids": ["*"] }`：任何擴充功能都能送訊息，**不含** `matches`，網頁一律不能呼叫。
- 核准狀態存在 `chrome.storage.local`：`approved_callers: string[]`、`pending_callers: { id: string; first_seen: number }[]`。只存擴充功能 ID 與時間，不存訊息內容。
- 收到訊息時先驗 `sender.id`：
  - 格式必須是 `/^[a-p]{32}$/`，否則回 `INVALID`。
  - 已核准 → 照常處理。
  - 未核准 → `ping` 回 `ready: false, approved: false`；`capabilities` 照常回；`deidentify` 回 `NOT_APPROVED`。並把 ID 加入 `pending_callers`（去重，最多保留 20 筆，超過捨棄最舊的），在擴充功能圖示顯示徽章提醒。
- 設定頁列出待核准與已核准的 ID，可「允許」「拒絕」「撤銷」。拒絕即從待核准清單移除。
- 使用流程：呼叫端第一次偵測時會看到「沒有回應」卡片 → 使用者到 deid-ckip 設定頁允許 → 回呼叫端按重試。README 要寫清楚這個流程；服務不預設任何呼叫者，也不需要知道呼叫端的 ID。

## 4. service.yaml

本 repo 根目錄的 `service.yaml` 是版本、協定、類型、上限與金鑰的唯一來源：

```yaml
id: deid-ckip
name: 去識別化（CKIP）
version: 0.1.0
protocol: deid@1
license: GPL-3.0

extension:
  id: fdchmnlidiijkhofoemcmpepibdnmgli
  key: MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy6nlJsHL7436luHs3xPjSik4dUprp4GvJYsbu5Os57Cb3IlPnhPx/XIpyRtnzcQaYcVcsDkjFW0sZ3bpUL6deupvzm6h0DERyB8poiUyRsEzyEefu2jR375NRV2RJMaeKQa7ZxxOn0H32q/AKQ8RMfc89LPqVG0BhdNX30armpEIRN9pgVDn81vSfyVbjw0fGr6Wk2GzUASwkaBEQ7JUT1+ZYFWrfRZOa9L211ZaYeN0a1RKYgtnxGJghDHGj0s2smUlYY/vKJ8hwxkeS6G4xzSfcKa3FF09pGQMVGeb5l0VQp0nCogGLWNajZFXCV/FfreU/ym+WuK7njLgxd65JwIDAQAB

model:
  source: ckiplab/albert-tiny-chinese-ner   # 候選；亦可評估 bert-tiny / albert-base
  format: onnx
  quantize: none                            # int8 實測標籤一致率僅 88.5%，改用 fp32（約 16 MB）
  tokenizer: bert-base-chinese              # CKIP 建議使用 BertTokenizerFast

entity_types: [PERSON, GPE, LOC, ORG, FAC, NORP, DATE, TIME]
max_chars_per_request: 20000
```

- `extension.key` 是公鑰（base64 SPKI DER），公開無風險；`extension.id` 由它算出。建置時重算並核對兩者一致，不一致就停止。
- `version`、`entity_types`、`max_chars_per_request` 是服務回覆 `ping`／`capabilities` 的唯一來源（建置時寫進設定），不要在程式裡另外寫死。

## 5. 架構與實作

### 5.1 目錄

```
service.yaml
package.json / tsconfig.json / vitest.config.ts
LICENSE                   GPL-3.0
README.md
SPEC.md                   （本文件）
src/
  background.ts           Service Worker：收訊息、驗核准狀態、轉交 offscreen
  offscreen.html
  offscreen.ts            載入 tokenizer＋ONNX 模型、執行 NER
  deid.ts                 純函式：字典比對、NER 結果合併、代號產生、替換（不碰 chrome API，方便測試）
  handler.ts              純函式：訊息驗證與分派（ping／capabilities／deidentify），以注入的 NER 與核准狀態運作
  settings.ts             唯一可寫 chrome.storage 的模組（鍵名白名單，見 8.1）
  options.html / options.ts   設定、狀態與核准頁
scripts/
  convert-model.py        下載 CKIP 模型 → ONNX → int8 量化 → models/
  build.ts                建置（第 7 節）
  key.ts                  從本機 .keys/deid-ckip.pem 算出公鑰與 ID，寫回 service.yaml（僅換金鑰時使用）
models/                   轉換產物（.gitignore，不進版控）
test/
  fixtures/contract/      deid@1 契約範例（供呼叫端測試共用，見 8.2）
  fixtures/samples/       自行撰寫的虛構病歷文字
```

- 服務是獨立擴充功能，不依賴 `flow-ext-repo` 的任何套件；需要的純函式以複製方式取得並註明來源。

### 5.2 manifest（由 scripts/build.ts 產生）

- `manifest_version: 3`，`name`／`version` 取自 service.yaml。
- `key`：`service.yaml` 的 `extension.key`。
- `externally_connectable: { ids: ["*"] }`。**不要**加 `matches`，不開放任何網頁。
- `permissions: ["offscreen", "storage"]`（storage 只存 8.1 列出的鍵：信心門檻、呼叫者核准狀態；**不存原文**）。
- `action`：點擊開啟設定頁，用來顯示待核准徽章。
- `options_page: options.html`。
- `content_security_policy.extension_pages`：`"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'"`（ONNX Runtime Web 需要 wasm；`connect-src 'self'` 讓瀏覽器擋下任何對外連線）。
- **不要**宣告 `host_permissions`；不要有任何 `fetch` 到外部網址。

### 5.3 背景 Service Worker

- `onMessageExternal`：先依 3.4 驗 `sender.id`。
- `ping`、`capabilities` 直接回覆（不等模型）。收到已核准呼叫者的 `ping` 時，若 offscreen 尚未建立，就建立並開始載入模型。
- `deidentify`：確保 offscreen 存在並完成載入後，用 `chrome.runtime.sendMessage`（內部訊息）轉交，把結果回給呼叫方。
- offscreen 建立：`chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '在本機執行去識別化模型' })`；建立前用 `chrome.offscreen.hasDocument()`／`getContexts` 避免重複建立。
- **存活驗證（D6，實作 deidentify 轉交前先做）**：
  1. 查 Chrome 官方文件：Service Worker 在等待 `onMessageExternal` 的 `sendResponse`、以及等待 offscreen 回覆時的閒置回收規則。
  2. 實測：offscreen 以延遲 150 秒的假推論回覆，確認 SW 是否在回覆前被回收、呼叫方是否收到結果。
  3. 會被回收 → offscreen 在推論期間每 20 秒送內部訊息給 SW 保活；不會 → 不加。結論與依據寫進 README。

### 5.4 offscreen：模型推論

- 用 ONNX Runtime Web（或 transformers.js）從**擴充功能內的** `models/` 載入；transformers.js 需設定 `env.allowRemoteModels = false`、`env.localModelPath` 指向擴充功能內路徑。wasm 檔也要打包在擴充功能內。
- 流程：tokenizer（`src/tokenizer.ts`，BERT WordPiece，含字元位移）→ 依 `max_len`（512 token，重疊 128）滑動視窗 → 模型 → 限制轉移的 Viterbi 選出合法 BIES 序列 → 合併成實體 span（對回原文字元位置）→ 分數取路徑上各 token 機率的最小值。
- 模型檔以 `fetch(chrome.runtime.getURL(...))` 讀取擴充功能自己的檔案；這是唯一允許的 `fetch` 用法（8.1 靜態檢查）。
- 過濾：只保留 `entity_types` 內的類型；跳過落在既有代號 `〔…〕` 內的 span。
- 結果交給 `deid.ts` 做字典合併、代號產生與替換。

### 5.5 deid.ts 的規則

1. 先找出文字中已存在的 `〔…〕` 代號區段，標為受保護。
2. 字典命中（完全比對，長詞優先，不跨受保護區段）。
3. 模型實體（與字典重疊時以字典為準；與受保護區段重疊時丟棄）。
4. 依出現順序替換；同一原文沿用 `existing_mapping`，否則依 3.3 產生新代號。
5. 累計 `counts`；分數低於門檻者列入 `low_confidence`（位置為回傳文字中的代號位置）。

### 5.6 設定／狀態頁

- 顯示：版本、協定、擴充功能 ID、模型狀態（未載入／載入中／就緒／失敗）。
- 呼叫者核准：待核准清單（ID、首次出現時間，「允許」「拒絕」）、已核准清單（「撤銷」）。
- 可調：信心門檻（預設 0.7）。
- 提供「測試」框：貼一段文字，在本機顯示替換結果（僅記憶體，不保存）。

## 6. 模型轉換（scripts/convert-model.py）

- 來源：`ckiplab/albert-tiny-chinese-ner`（也可評估 `ckiplab/bert-tiny-chinese-ner`）；tokenizer 用 `bert-base-chinese`（CKIP 建議 `BertTokenizerFast`）。
- 轉 ONNX（`torch.onnx.export`，dynamic axes）。`quantize: int8` 時再做動態量化；轉換後與 PyTorch 比對逐 token 標籤一致率，低於 0.97 就停止。2026-09-29 實測 int8 一致率 88.5%，因此採 fp32。
- 產物：`models/model.onnx`、`vocab.txt`、`config.json`（含 `id2label`、`do_lower_case`、`max_len`）。tokenizer 以 TypeScript 自行實作 BERT WordPiece（需要字元位移，見 5.4）。記錄產物 sha256 於 `models/manifest.json`，另將同一份 sha256 清單以 `model-manifest.json` 進版控，建置時核對。
- 產物不進版控；README 寫清楚一次性轉換步驟與 Python 版本、套件版本。
- 標籤：CKIP 用 OntoNotes 18 類（可能是 `B-`/`I-`/`E-`/`S-` 或 BIO，**以 config 的 id2label 為準**，不要假設）。

## 7. 建置：pnpm build

`scripts/build.ts`：

1. 讀 `service.yaml`，用 zod 驗證必要欄位（錯誤訊息指出檔案與欄位）；由 `extension.key` 重算 ID，與 `extension.id` 不符就停止。
2. 檢查 `models/` 存在且 sha256 與 `model-manifest.json` 相符；不符就停止並提示執行 convert-model。
3. esbuild 打包 `background.ts`、`offscreen.ts`、`options.ts`；複製 html、models、onnx wasm。
4. 產生 manifest（5.2），輸出到 `dist/deid-ckip/`，並用 fflate 產生 `dist/deid-ckip-<version>.zip`。
5. 印出「建置完成：dist/deid-ckip；擴充功能 ID …」。

`pnpm key`（`scripts/key.ts`）：讀本機 `.keys/deid-ckip.pem`，算出公鑰與 ID，寫回 `service.yaml`。只有換金鑰時才需要；一般建置不需要私鑰。

## 8. 測試（Vitest）

### 8.1 單元（不需要模型，用假的實體清單）

- `id`、`request_id` 原樣回傳；每段都有回。
- 既有 `existing_mapping` 的代號不變；新代號字母接續（例如已有 `〔人物A〕` → 新人物是 `〔人物B〕`）。
- 與基本規則代號共存：文字含 `〔手機A〕` 時不被改動、不被當成實體。
- 字典優先、長詞優先；自訂 type（如 `病人`）產生 `〔病人A〕`。
- `low_confidence` 位置正確且該實體仍被替換。
- `TOO_LARGE`、`INVALID`、`NOT_APPROVED` 錯誤格式。
- 核准：未核准 ID 的 `deidentify` 被拒、`ping` 回 `approved: false` 且被列入待核准；待核准清單去重且上限 20；格式不符的 `sender.id` 回 `INVALID`；核准後放行、撤銷後再被拒。
- 不保存原文（D5）：
  - 靜態：`src/` 內的 `fetch(` 只能是 `fetch(chrome.runtime.getURL(`；沒有 `XMLHttpRequest`、`WebSocket`、`EventSource`、`navigator.sendBeacon`；`chrome.storage` 只出現在 `settings.ts`；`settings.ts` 只寫入鍵 `threshold`、`approved_callers`、`pending_callers`。
  - 執行期：用假的 `chrome.storage` 跑完整的 ping → deidentify 流程，確認儲存內容只有上述三個鍵，且序列化後不含任何輸入文字、字典詞或 `existing_mapping` 的原文。

### 8.2 契約 fixture

- `test/fixtures/contract/*.json`：每個檔案含 `request`、注入的假實體、`expected_response`，涵蓋 3.2 的必須遵守各條。本 repo 以 `handler.ts` 跑全部 fixture。
- 這些 fixture 是本 repo 公布的契約，呼叫端可自行取用來做相容測試；本 repo 不依賴呼叫端是否使用。

### 8.3 模型（需要 models/，以環境變數 `DEID_MODEL_TESTS=1` 控制是否執行）

- 固定樣本（`test/fixtures/samples/`，自行撰寫的虛構病歷文字，不可用真實個資）：人名、醫院、縣市、日期都有被替換，並回報數量。
- 記錄跨段切斷的已知限制：實體被切在兩段之間時，各段分別處理的結果。

### 8.4 SW 存活實測

- 5.3 的存活驗證以 Playwright 載入 `dist/deid-ckip` 與一個測試用呼叫端擴充功能（`test/e2e/caller/`）執行，保留腳本供回歸。

## 9. 驗收

- 本 repo：`pnpm test`、`pnpm typecheck` 全過；`pnpm build` 可直接建置並在 Chrome 以「載入未封裝」使用，ID 為 `fdchmnlidiijkhofoemcmpepibdnmgli`。
- 未核准的擴充功能呼叫被拒絕，核准後可用，撤銷後再被拒。
- 服務不連網、不保存收到的原文（8.1 靜態＋執行期測試，以及程式碼審視）。
- 以本 repo 的測試用呼叫端擴充功能（`test/e2e/caller/`）端對端驗證：ping → 未核准被拒 → 核准 → deidentify 替換正確、跨請求代號一致。

## 10. 不可違反

- 服務只是呼叫端隱私閘門使用的工具；不提供任何繞過閘門的用途說明或捷徑。
- 服務不保存對照表（由呼叫方帶 `existing_mapping`），不保存收到的原文。
- 任何無法處理的狀況 → 回錯誤讓呼叫方停下來問人，不猜測、不略過（例如模型載入失敗不可「沒替換就回傳原文」）。
- 私鑰、模型產物、真實個資一律不進版控。
- 修改協定行為時同步更新 README 與契約 fixture；不相容的修改要升協定版本（例如 deid@2），並在 release notes 說明。

## 11. 待確認（實作時採暫定值，程式中標 TODO，並在完成回報中列出）

1. **跨段實體**：呼叫方硬切 20000 字，實體可能被切斷。暫定不處理，列為已知限制；若要改善，應改呼叫方切在句號或換行，而不是服務端處理。
2. **文獻全文的作者、機構**：已發表論文的作者姓名也會被替換。暫定照替換（保守）；請在回報中提出是否要讓呼叫方對「已發表文獻全文」預設不送服務。
3. **授權**：CKIP 模型與服務為 GPL-3.0；呼叫端只透過訊息溝通。上架商店前需確認授權。
4. **商店上架後的 ID**：上架時商店會配發新 ID，需更新 `service.yaml` 的 `extension` 與 README，並在 release notes 公布新 ID。

## 12. 給 `flow-ext-repo` 的參考（呼叫端自己的工作，不是本 repo 的完成條件）

1. `packages/pack-builder/src/build.ts` 的 `servicesOf`：不再讀 `services/<id>/service.yaml`、不再檢查 `allowed_callers`、不再用 `.keys/<id>.pem` 算 ID；改為讀一份服務登記檔（例如 `services/deid-ckip.yaml`：`id`、`protocol`、`extension_id`、`install_url`、`repo`），內容取自本 repo 公布的值。
2. 移除 `packages/pack-builder/src/cli/build-service.ts` 與 `pnpm build:service`；`services/deid-ckip/` 目錄改為上述登記檔。`.keys/deid-ckip.pem` 已移到本 repo 維護者本機，可從 `flow-ext-repo` 移除。
3. 相容測試：用 `PrivacyGate` 搭配一個「直接呼叫本 repo `handler.ts`」或「讀本 repo 契約 fixture」的 `DeidClient`，跑含人名、地名、機構、日期、手機號碼的繁體中文樣本，確認基本規則與服務代號並存不撞號、同一任務連續兩次呼叫代號一致、`restore()` 能完整還原。
4. E2E（比照 `e2e/drive-ai.mjs`）：以環境變數指定本 repo 的 `dist/deid-ckip`，同時載入 research-evidence；未安裝時出現「尚未安裝」卡片；安裝但未核准時出現「沒有回應」，到 deid-ckip 設定頁允許後重試可繼續；走到送出全文的步驟（15 或 17），側邊欄出現「要使用去識別化嗎？」→ 選「使用」→ 送出的指令中人名已換成代號、紀錄出現 `deid_applied`。
5. （選配）讀 `ping` 回覆的 `approved: false`，把卡片文字改成「請到去識別化擴充功能設定頁核准」。
6. 文件：`docs/ROADMAP.md` 第 8 步、`docs/SERVICE_EXTENSIONS.md`（服務改為外部 repo、核准流程、代號 role 對照表、`low_confidence` 語意、錯誤碼含 `NOT_APPROVED`、逾時）、`docs/PRIVACY.md`（D4：日期處理與 `gate.ts` 的 DATE/TIME 不一致，由專案決定）、`e2e/README.md`。

## 13. 本 repo 完成後要更新

- `README.md`：用途、呼叫者核准流程、目前已知呼叫端 ID、模型轉換步驟、建置與本機載入方式、SW 存活驗證結論、已知限制。
- 契約 fixture 與 `service.yaml` 版本號。
