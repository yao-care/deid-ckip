// 歡迎頁：第一次安裝時由 background 開啟，說明用法並載入模型。

import { $, loadModel } from './ui.ts'

void loadModel($('model-state'), (s) => {
  const err = $('model-error')
  err.hidden = s.state !== 'failed'
  err.textContent = s.error ? `模型載入失敗：${s.error}` : ''
  $('model-title').textContent = s.state === 'ready' ? '模型已就緒，可以開始使用' : s.state === 'failed' ? '模型載入失敗' : '模型準備中'
})
