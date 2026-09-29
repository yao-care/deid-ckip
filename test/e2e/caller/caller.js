// 與 flow-ext-repo 的 chromeDeidClient 相同的呼叫方式：sendMessage＋lastError＋逾時。
globalThis.callDeid = (serviceId, msg, timeoutMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ reason: 'no_response' }), timeoutMs)
    chrome.runtime.sendMessage(serviceId, msg, (res) => {
      clearTimeout(timer)
      if (chrome.runtime.lastError) resolve({ reason: 'not_installed', error: chrome.runtime.lastError.message })
      else resolve({ data: res })
    })
  })
