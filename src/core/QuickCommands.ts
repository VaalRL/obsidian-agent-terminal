import { EnvironmentService } from '../services/EnvironmentService';
import type { PtyService } from '../services/PtyService';
import type { AgentTerminalSettings, QuickCommand } from './settings';

export type QuickCommandResult = 'sent' | 'busy' | 'unavailable' | 'empty' | 'no-default';

type QuickCommandPty = Pick<PtyService, 'isTerminated' | 'write' | 'getForegroundProcess'>;

// 前景程式查詢沒有回覆時的重試次數 (每次最多等 500ms，合計約 3 秒)
const FOREGROUND_QUERY_ATTEMPTS = 6;

/**
 * 在終端機送出 quick command：先確認 shell 正在等待指令，清空輸入行，再輸入指令並按 Enter。
 * - 前景已有其他程式 (例如 claude 正在執行) → 不送，回傳 busy，避免把指令打進該程式
 * - 無法判斷前景程式 (Windows) → 仍送出：這是使用者主動按的，與自動 cd 不同
 * - bridge 沒有回覆 (剛啟動、卡住) → 重試數次，仍無回覆則回傳 unavailable，不盲目送出
 */
export async function sendQuickCommand(
    pty: QuickCommandPty,
    shellPath: string,
    command: string,
    options: { platform?: string; cwd?: string } = {}
): Promise<QuickCommandResult> {
    const platform = options.platform ?? process.platform;
    // 多行內容會被 shell 當成多個指令執行，一律合併成一行
    const line = command.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!line) return 'empty';
    if (pty.isTerminated) return 'unavailable';

    // bridge 剛啟動 (還在載入 node-pty) 時查詢可能沒有回覆 (undefined)：再問幾次，
    // 一直沒有回覆就不送，避免把指令打進可能正在執行的程式
    let foreground = await pty.getForegroundProcess();
    for (let attempt = 1; foreground === undefined && attempt < FOREGROUND_QUERY_ATTEMPTS && !pty.isTerminated; attempt++) {
        foreground = await pty.getForegroundProcess();
    }
    if (foreground === undefined || pty.isTerminated) return 'unavailable';
    if (foreground !== null && !EnvironmentService.isShellProcess(shellPath, foreground)) return 'busy';

    // 指定 cwd (例如 Vault 根目錄) 時先 cd 再執行，兩行一次送出
    const cd = options.cwd ? EnvironmentService.buildCdCommand(shellPath, options.cwd) : '';
    pty.write(EnvironmentService.buildClearLineSequence(shellPath, platform) + cd + line + '\r');
    return 'sent';
}

// 讓 AI agent 不經確認就執行動作的參數：
// - --dangerously-skip-permissions (Claude Code、agy)、--allow-dangerously-skip-permissions 與
//   --permission-mode bypassPermissions (Claude Code)
// - --dangerously-bypass-approvals-and-sandbox 與 danger-full-access 沙箱 (Codex)
// - --auto (opencode：自動核准未明確拒絕的權限)、--yolo (舊版 Codex 等)
const DANGEROUS_FLAGS = [
    /--(allow-)?dangerously-/i,
    /--permission-mode[=\s]+bypassPermissions/i,
    /danger-full-access/i,
    /(^|\s)--auto(=true)?(?=\s|$)/i,
    /--yolo\b/i,
];

/** 指令是否帶有讓 agent 不經確認就執行動作的參數 (設定頁會顯示警告) */
export function isDangerousCommand(command: string): boolean {
    return DANGEROUS_FLAGS.some(flag => flag.test(command));
}

/**
 * 依指令開頭的程式名稱 (claude、agy…) 把相鄰的 quick commands 分組，供選單以分隔線區隔。
 * 保持使用者排列的順序，不重新排序；空指令略過。
 */
export function groupByProgram(commands: QuickCommand[]): QuickCommand[][] {
    const groups: QuickCommand[][] = [];
    let lastProgram: string | null = null;
    for (const quickCommand of commands) {
        const program = quickCommand.command.trim().split(/\s+/)[0];
        if (!program) continue;
        if (program !== lastProgram) groups.push([]);
        groups[groups.length - 1].push(quickCommand);
        lastProgram = program;
    }
    return groups;
}

/** 一個 quick command 註冊成 Obsidian 指令時用到的內容 */
export interface QuickCommandRegistration {
    id: string;              // Obsidian 指令 id (以 quick command 固定的 id 組成，改名不會失去快捷鍵)
    quickCommandId: string;  // 執行時依此 id 查設定，所以指令內容變更不必重新註冊
    name: string;            // 指令面板顯示的名稱
}

/** 要註冊成 Obsidian 指令的 quick commands (指令為空的略過) */
export function quickCommandRegistrations(commands: QuickCommand[]): QuickCommandRegistration[] {
    return commands
        .filter(quickCommand => quickCommand.command.trim())
        .map(quickCommand => ({
            id: `quick-command-${quickCommand.id}`,
            quickCommandId: quickCommand.id,
            name: `Run quick command: ${quickCommand.name || quickCommand.command}`
        }));
}

/** 兩組註冊內容是否相同 (相同就不必重新註冊；設定頁打字時會反覆存檔) */
export function sameRegistrations(a: QuickCommandRegistration[], b: QuickCommandRegistration[]): boolean {
    return a.length === b.length
        && a.every((item, i) => item.id === b[i].id && item.quickCommandId === b[i].quickCommandId && item.name === b[i].name);
}

/**
 * 按鈕的預設 quick command；未設定、已被刪除或指令為空時回傳 null (按鈕改為顯示選單)
 */
export function resolveDefaultQuickCommand(
    settings: Pick<AgentTerminalSettings, 'quickCommands' | 'defaultQuickCommandId'>
): QuickCommand | null {
    if (!settings.defaultQuickCommandId) return null;
    const quickCommand = settings.quickCommands.find(q => q.id === settings.defaultQuickCommandId);
    return quickCommand && quickCommand.command.trim() ? quickCommand : null;
}
