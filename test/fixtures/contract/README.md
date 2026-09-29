# deid@1 契約 fixture

每個 JSON 是一組「請求 → 預期回覆」，本 repo 的 `test/contract.test.ts` 以 `src/handler.ts` 逐一驗證。

- `request`：呼叫方送出的 deidentify 訊息，原樣可用。
- `entities`：假設模型辨識出的實體，依段落 id 列出 `[原文, 類型, 分數?]`（分數預設 0.99；同一原文在段落中每次出現都算）。呼叫端若要用這些 fixture 做相容測試，可用同樣規則產生假的服務回覆，或直接比對 `response`。
- `response`：服務應回覆的完整內容。
- `"__REPEAT_x_20001__"`：代表 20001 個 `x`（避免 fixture 過大）。

呼叫者一律視為已核准；核准流程見 SPEC 3.4。
