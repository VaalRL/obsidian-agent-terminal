// 外掛在 Obsidian (瀏覽器環境) 中以 window.setTimeout 等計時器執行 (popout 視窗相容)；
// 測試在 node 環境執行沒有 window，指向 globalThis 讓 vi.useFakeTimers() 也能接管這些計時器
const globals = globalThis as { window?: unknown };
globals.window ??= globalThis;
