// 點工具列圖示開啟測試頁；端對端測試也靠這個 Service Worker 取得擴充功能 ID。
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'caller.html' }))
