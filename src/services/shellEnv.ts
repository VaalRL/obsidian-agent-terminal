/**
 * bridge 程序本身需要 ELECTRON_RUN_AS_NODE (以 Obsidian 內建 Electron 當 Node 執行) 與
 * 指向外掛 node_modules 的 NODE_PATH，但這些不能傳給使用者的 shell：
 * - ELECTRON_RUN_AS_NODE 會讓 shell 裡啟動的 Electron 程式 (例如 Obsidian 官方 CLI) 以 Node 執行
 * - 外掛的 NODE_PATH 會改變使用者自己的 Node 程式找模組的位置
 * PtyService 把使用者原本的 NODE_PATH 存在此變數，由 bridge 還原。
 */
export const ORIGINAL_NODE_PATH_VAR = 'AGENT_TERMINAL_ORIGINAL_NODE_PATH';

/**
 * xterm.js 支援 256 色與 24-bit 色彩。node-pty 在 macOS/Linux 會以 spawn 的 name 設定 TERM，
 * 在 Windows 則不會，所以由 buildShellEnv 一併寫入 TERM，讓各平台一致。
 */
export const TERMINAL_NAME = 'xterm-256color';

export function buildShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result = { ...env };
    delete result.ELECTRON_RUN_AS_NODE;

    // 由終端機宣告自己的色彩能力。從其他工具 (例如 Claude Code 會設 NO_COLOR=1) 啟動的 Obsidian
    // 會繼承它們的 NO_COLOR / TERM=dumb，傳下去會讓終端機裡所有 CLI 都只輸出黑白
    delete result.NO_COLOR;
    result.TERM = TERMINAL_NAME;
    result.COLORTERM = 'truecolor';

    const originalNodePath = result[ORIGINAL_NODE_PATH_VAR];
    delete result[ORIGINAL_NODE_PATH_VAR];
    if (originalNodePath) {
        result.NODE_PATH = originalNodePath;
    } else {
        delete result.NODE_PATH;
    }
    return result;
}
