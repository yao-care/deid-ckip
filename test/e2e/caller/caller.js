// 與 flow-ext-repo 的 chromeDeidClient 相同的呼叫方式：sendMessage＋lastError＋逾時。
const DEID_ID = 'fdchmnlidiijkhofoemcmpepibdnmgli'

globalThis.callDeid = (serviceId, msg, timeoutMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ reason: 'no_response' }), timeoutMs)
    chrome.runtime.sendMessage(serviceId, msg, (res) => {
      clearTimeout(timer)
      if (chrome.runtime.lastError) resolve({ reason: 'not_installed', error: chrome.runtime.lastError.message })
      else resolve({ data: res })
    })
  })

// 手動操作用的按鈕（端對端測試不使用）
const out = document.getElementById('out')
const show = (r) => (out.textContent = JSON.stringify(r, null, 2))
document.getElementById('ping').addEventListener('click', async () => {
  show(await globalThis.callDeid(DEID_ID, { type: 'ping', caller_name: 'deid-ckip 測試呼叫端' }, 3000))
})
document.getElementById('deid').addEventListener('click', async () => {
  out.textContent = '處理中…'
  show(
    await globalThis.callDeid(
      DEID_ID,
      {
        type: 'deidentify',
        request_id: `r_${Date.now()}`,
        texts: [{ id: '0:0', text: document.getElementById('text').value }],
        entity_types: ['PERSON', 'GPE', 'LOC', 'ORG', 'FAC', 'NORP', 'DATE', 'TIME'],
        dictionary: [],
        existing_mapping: {},
        pseudonym_style: '〔{role}{letter}〕',
        caller_name: 'deid-ckip 測試呼叫端',
      },
      120000,
    ),
  )
})
