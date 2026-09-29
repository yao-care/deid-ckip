// 建置時由 scripts/build.ts 以 esbuild define 注入（來源：service.yaml）。
declare const __SERVICE__: import('./handler.ts').ServiceConfig
// 僅測試建置使用：辨識前人工延遲的毫秒數（正式建置為 0），用來實測 Service Worker 存活（SPEC 5.3）。
declare const __TEST_DELAY_MS__: number
