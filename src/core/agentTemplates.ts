import type { QuickCommand } from './settings';

/**
 * 各 AI agent 的 quick command 範本 (設定頁「Add … presets」按鈕與預設清單使用)。
 * 範本只是預先填好的一般指令文字，加入後使用者可自由修改；CLI 改版時不必等外掛更新。
 *
 * 啟動選項對照 (已用各 CLI 的 `--help` 核對：claude、agy、codex 0.160、opencode 1.18)：
 * | 動作               | Claude Code / Antigravity CLI (agy)         | Codex CLI                                                     | opencode                    |
 * | ------------------ | ------------------------------------------- | ------------------------------------------------------------- | --------------------------- |
 * | 新對話             | claude / agy                                | codex                                                         | opencode                    |
 * | 繼續上次           | … --continue                                | codex resume --last (codex 的 -c 是 --config)                 | opencode --continue         |
 * | 跳過權限確認       | … --dangerously-skip-permissions            | codex --dangerously-bypass-approvals-and-sandbox (也關閉沙箱) | opencode --auto             |
 * | 繼續上次＋跳過權限 | … --continue --dangerously-skip-permissions | codex resume --last --dangerously-bypass-approvals-and-sandbox | opencode --continue --auto  |
 *
 * 預設清單只放 Claude Code 與 agy (選單保持精簡)；Codex、opencode、Ollama 由設定頁的「Add … presets」加入。
 */
export interface AgentTemplate {
    id: string;
    label: string;
    // id 為建議的固定 id：預設清單沿用，重新加入範本時也盡量沿用，讓快捷鍵持續有效
    commands: QuickCommand[];
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
    {
        id: 'claude',
        label: 'Claude Code',
        commands: [
            { id: 'claude', name: 'Claude Code', command: 'claude' },
            { id: 'claude-continue', name: 'Claude Code: continue last session', command: 'claude --continue' },
            { id: 'claude-skip-permissions', name: 'Claude Code: skip permission prompts', command: 'claude --dangerously-skip-permissions' },
            { id: 'claude-continue-skip-permissions', name: 'Claude Code: continue, skip permission prompts', command: 'claude --continue --dangerously-skip-permissions' }
        ]
    },
    {
        id: 'agy',
        label: 'Antigravity CLI',
        commands: [
            { id: 'agy', name: 'Antigravity CLI', command: 'agy' },
            { id: 'agy-continue', name: 'Antigravity CLI: continue last session', command: 'agy --continue' },
            { id: 'agy-skip-permissions', name: 'Antigravity CLI: skip permission prompts', command: 'agy --dangerously-skip-permissions' },
            { id: 'agy-continue-skip-permissions', name: 'Antigravity CLI: continue, skip permission prompts', command: 'agy --continue --dangerously-skip-permissions' }
        ]
    },
    {
        id: 'codex',
        label: 'Codex CLI',
        commands: [
            { id: 'codex', name: 'Codex CLI', command: 'codex' },
            { id: 'codex-continue', name: 'Codex CLI: resume last session', command: 'codex resume --last' },
            { id: 'codex-skip-permissions', name: 'Codex CLI: skip approvals and sandbox', command: 'codex --dangerously-bypass-approvals-and-sandbox' },
            { id: 'codex-continue-skip-permissions', name: 'Codex CLI: resume, skip approvals and sandbox', command: 'codex resume --last --dangerously-bypass-approvals-and-sandbox' }
        ]
    },
    {
        id: 'opencode',
        label: 'opencode',
        commands: [
            { id: 'opencode', name: 'opencode', command: 'opencode' },
            { id: 'opencode-continue', name: 'opencode: continue last session', command: 'opencode --continue' },
            { id: 'opencode-skip-permissions', name: 'opencode: auto-approve permissions', command: 'opencode --auto' },
            { id: 'opencode-continue-skip-permissions', name: 'opencode: continue, auto-approve permissions', command: 'opencode --continue --auto' }
        ]
    },
    {
        // Ollama 本身不是 agent：`ollama launch` 讓上面的 agent 改用本機或 Ollama 雲端模型 (`--` 之後的參數原樣交給 agent)。
        // 第一次啟動時選模型，之後沿用同一個 agent 上次的模型。工具要能用，模型需支援 tools、context 64k 以上；
        // 本機小模型較容易誤用工具，所以不提供跳過權限確認的版本。Antigravity CLI 不在 ollama launch 支援之列。
        id: 'ollama',
        label: 'Ollama',
        commands: [
            { id: 'ollama-claude', name: 'Ollama: Claude Code', command: 'ollama launch claude' },
            { id: 'ollama-claude-continue', name: 'Ollama: Claude Code, continue last session', command: 'ollama launch claude -- --continue' },
            { id: 'ollama-codex', name: 'Ollama: Codex CLI', command: 'ollama launch codex' },
            { id: 'ollama-codex-continue', name: 'Ollama: Codex CLI, resume last session', command: 'ollama launch codex -- resume --last' },
            { id: 'ollama-opencode', name: 'Ollama: opencode', command: 'ollama launch opencode' },
            { id: 'ollama-opencode-continue', name: 'Ollama: opencode, continue last session', command: 'ollama launch opencode -- --continue' }
        ]
    }
];

/** 預設 quick command 清單使用的範本 (其餘範本由設定頁按鈕加入) */
export const DEFAULT_TEMPLATE_IDS = ['claude', 'agy'];

/**
 * 把範本的指令加到清單尾端 (回傳新陣列，不修改原清單)：
 * 已有相同指令的略過；範本 id 已被使用時改用 newId() 產生的 id。
 */
export function addTemplateCommands(existing: QuickCommand[], template: AgentTemplate, newId: () => string): QuickCommand[] {
    const result = [...existing];
    const usedIds = new Set(existing.map(q => q.id));
    const usedCommands = new Set(existing.map(q => q.command.trim()));

    for (const preset of template.commands) {
        if (usedCommands.has(preset.command)) continue;
        const id = usedIds.has(preset.id) ? newId() : preset.id;
        usedIds.add(id);
        result.push({ id, name: preset.name, command: preset.command });
    }
    return result;
}
