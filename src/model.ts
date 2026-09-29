// 由模型檔案建立 NerModel。onnxruntime 由呼叫端傳入：offscreen 用瀏覽器版，測試用 Node 版（同為 onnxruntime-web）。

import type * as Ort from 'onnxruntime-web'
import type { NerModel } from './ner.ts'
import { WordPieceTokenizer } from './tokenizer.ts'

export interface ModelConfig {
  do_lower_case: boolean
  max_len: number
  id2label: Record<string, string>
}

export async function createNerModel(
  ort: typeof Ort,
  files: { model: Uint8Array; vocab: string; config: ModelConfig },
): Promise<NerModel> {
  const session = await ort.InferenceSession.create(files.model, { executionProviders: ['wasm'] })
  const tokenizer = new WordPieceTokenizer(files.vocab, files.config.do_lower_case)
  const tensor = (a: number[]) => new ort.Tensor('int64', BigInt64Array.from(a, (x) => BigInt(x)), [1, a.length])
  return {
    tokenizer,
    id2label: files.config.id2label,
    maxLen: files.config.max_len,
    async run(ids) {
      const out = await session.run({
        input_ids: tensor(ids),
        attention_mask: tensor(ids.map(() => 1)),
        token_type_ids: tensor(ids.map(() => 0)),
      })
      return out.logits!.data as Float32Array
    },
  }
}
