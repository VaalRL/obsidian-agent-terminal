import { AGENT_TEMPLATES, DEFAULT_TEMPLATE_IDS } from './agentTemplates';

export enum CwdMode {
    VaultRoot = 'vaultRoot',
    CurrentFile = 'currentFile',
    CustomPath = 'customPath'
}

/** 從終端機標題列的 🤖 選單或快捷鍵一鍵送出的指令 (例如啟動 AI agent) */
export interface QuickCommand {
    id: string;      // 固定不變，用於 Obsidian 指令 id，改名也不會失去快捷鍵
    name: string;
    command: string;
}

export interface AgentTerminalSettings {
    shellPath: string; // 用戶選擇或自訂的 shell 路徑
    cwdMode: CwdMode; // 終端機啟動的目錄模式
    customCwdPath: string; // 當 cwdMode 為 CustomPath 時的指定路徑
    autoSyncCwd: boolean; // 是否在切換筆記時自動 cd 到該目錄
    quickCommands: QuickCommand[];
    // 送出 quick command 前先 cd 到 Vault 根目錄：agent 的「繼續上次」以啟動資料夾為範圍，
    // 指示檔 (CLAUDE.md、GEMINI.md…) 也在根目錄
    quickCommandsFromVaultRoot: boolean;
    // 按下 🤖 按鈕時直接送出的 quick command id；空字串表示按鈕改為顯示選單
    defaultQuickCommandId: string;
}

export const DEFAULT_SETTINGS: AgentTerminalSettings = {
    shellPath: '', // 預設為空，由自動偵測邏輯填補
    cwdMode: CwdMode.VaultRoot,
    customCwdPath: '',
    autoSyncCwd: false,
    quickCommands: AGENT_TEMPLATES
        .filter(template => DEFAULT_TEMPLATE_IDS.includes(template.id))
        .flatMap(template => template.commands),
    quickCommandsFromVaultRoot: true,
    defaultQuickCommandId: '',
};

function isQuickCommand(value: unknown): value is QuickCommand {
    const q = value as QuickCommand;
    return typeof value === 'object' && value !== null
        && typeof q.id === 'string' && typeof q.name === 'string' && typeof q.command === 'string';
}

/**
 * 合併已儲存的設定與預設值。quickCommands 一律複製一份，避免設定頁的修改改到 DEFAULT_SETTINGS；
 * 舊版沒有 quickCommands 的使用者會拿到預設清單。
 */
export function mergeSettings(saved: unknown): AgentTerminalSettings {
    const data = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<AgentTerminalSettings>;
    const quickCommands = Array.isArray(data.quickCommands)
        ? data.quickCommands.filter(isQuickCommand)
        : DEFAULT_SETTINGS.quickCommands;

    return {
        ...DEFAULT_SETTINGS,
        ...data,
        quickCommands: quickCommands.map(q => ({ id: q.id, name: q.name, command: q.command })),
        defaultQuickCommandId: typeof data.defaultQuickCommandId === 'string' ? data.defaultQuickCommandId : ''
    };
}
