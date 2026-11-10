import { describe, it, expect, vi } from 'vitest';

import { sendQuickCommand, isDangerousCommand } from '../src/core/QuickCommands';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings';
import { AGENT_TEMPLATES, addTemplateCommands } from '../src/core/agentTemplates';
import { groupByProgram, resolveDefaultQuickCommand, quickCommandRegistrations, sameRegistrations } from '../src/core/QuickCommands';

/** foreground：前景程式名稱；null = bridge 回報無法判斷 (Windows)；undefined = bridge 沒有回覆 */
function fakePty(foreground: string | null | undefined, terminated = false) {
    return {
        isTerminated: terminated,
        write: vi.fn(),
        getForegroundProcess: vi.fn(async (): Promise<string | null | undefined> => foreground)
    };
}

describe('sendQuickCommand', () => {
    it('should clear the input line, then type the command and press Enter when the shell is idle', async () => {
        const pty = fakePty('bash');

        await expect(sendQuickCommand(pty, '/bin/bash', 'claude --continue', { platform: 'linux' })).resolves.toBe('sent');

        expect(pty.write).toHaveBeenCalledWith('\x05\x15claude --continue\r');
    });

    it.each(['claude', 'agy', 'vim', 'node'])('should not type into a running program (%s)', async (program) => {
        const pty = fakePty(program);

        await expect(sendQuickCommand(pty, '/bin/zsh', 'claude', { platform: 'darwin' })).resolves.toBe('busy');

        expect(pty.write).not.toHaveBeenCalled();
    });

    it('should still send when the foreground program cannot be detected (Windows), since the user asked for it', async () => {
        const pty = fakePty(null);

        await expect(sendQuickCommand(pty, 'C:\\Windows\\System32\\cmd.exe', 'claude', { platform: 'win32' })).resolves.toBe('sent');

        expect(pty.write).toHaveBeenCalledWith('\x1bclaude\r');
    });

    // bridge 剛啟動 (還在載入 node-pty) 時查詢可能沒有回覆：再問一次，不要直接打字進可能正在執行的程式
    it('should ask again when the bridge has not answered yet, then send to an idle shell', async () => {
        const pty = fakePty('bash');
        pty.getForegroundProcess.mockResolvedValueOnce(undefined);

        await expect(sendQuickCommand(pty, '/bin/bash', 'claude', { platform: 'linux' })).resolves.toBe('sent');

        expect(pty.getForegroundProcess).toHaveBeenCalledTimes(2);
        expect(pty.write).toHaveBeenCalledTimes(1);
    });

    it('should not type into a program that is found running once the bridge answers', async () => {
        const pty = fakePty('vim');
        pty.getForegroundProcess.mockResolvedValueOnce(undefined);

        await expect(sendQuickCommand(pty, '/bin/bash', 'claude', { platform: 'linux' })).resolves.toBe('busy');
        expect(pty.write).not.toHaveBeenCalled();
    });

    it('should report unavailable instead of typing blindly when the bridge never answers', async () => {
        const pty = fakePty(undefined);

        await expect(sendQuickCommand(pty, '/bin/bash', 'claude', { platform: 'linux' })).resolves.toBe('unavailable');
        expect(pty.write).not.toHaveBeenCalled();
    });

    it('should report a terminal whose session has ended', async () => {
        const pty = fakePty('bash', true);

        await expect(sendQuickCommand(pty, '/bin/bash', 'claude', { platform: 'linux' })).resolves.toBe('unavailable');
        expect(pty.write).not.toHaveBeenCalled();
    });

    it('should trim the command and refuse an empty one', async () => {
        const pty = fakePty('bash');

        await expect(sendQuickCommand(pty, '/bin/bash', '   ', { platform: 'linux' })).resolves.toBe('empty');
        await sendQuickCommand(pty, '/bin/bash', '  agy  ', { platform: 'linux' });

        expect(pty.write).toHaveBeenCalledTimes(1);
        expect(pty.write).toHaveBeenCalledWith('\x05\x15agy\r');
    });

    it('should cd to the requested folder first (e.g. the vault root) in the same keystrokes', async () => {
        const pty = fakePty('zsh');

        await sendQuickCommand(pty, '/bin/zsh', 'claude --continue', { platform: 'darwin', cwd: '/Users/me/My Vault' });

        expect(pty.write).toHaveBeenCalledWith("\x05\x15cd '/Users/me/My Vault'\rclaude --continue\r");
    });

    it('should use the shell-specific cd command when changing folder first', async () => {
        const pty = fakePty(null);

        await sendQuickCommand(pty, 'C:\\Windows\\System32\\cmd.exe', 'agy', { platform: 'win32', cwd: 'D:\\Vault' });

        expect(pty.write).toHaveBeenCalledWith('\x1bcd /d "D:\\Vault"\ragy\r');
    });

    it('should not send multi-line commands as several commands', async () => {
        const pty = fakePty('bash');

        await sendQuickCommand(pty, '/bin/bash', 'claude\nrm -rf ~', { platform: 'linux' });

        expect(pty.write).toHaveBeenCalledWith('\x05\x15claude rm -rf ~\r');
    });
});

// 設定頁以 400ms debounce 存檔；只有影響 Obsidian 指令 (id、顯示名稱、清單) 的變更才需要重新註冊
describe('quick command registrations (Obsidian commands)', () => {
    const commands = () => [
        { id: 'a', name: 'Claude', command: 'claude' },
        { id: 'b', name: '', command: 'agy' },
        { id: 'c', name: 'Empty', command: '   ' }
    ];

    it('should register each non-empty quick command under its fixed id and display name', () => {
        expect(quickCommandRegistrations(commands())).toEqual([
            { id: 'quick-command-a', quickCommandId: 'a', name: 'Run quick command: Claude' },
            { id: 'quick-command-b', quickCommandId: 'b', name: 'Run quick command: agy' }
        ]);
    });

    it('should not need re-registering when only the command text of a named quick command changes', () => {
        const edited = commands();
        edited[0].command = 'claude --continue';

        expect(sameRegistrations(quickCommandRegistrations(commands()), quickCommandRegistrations(edited))).toBe(true);
    });

    it.each([
        ['a name changes', (list: ReturnType<typeof commands>) => { list[0].name = 'Claude Code'; }],
        ['an unnamed command changes (it is the display name)', (list: ReturnType<typeof commands>) => { list[1].command = 'agy --continue'; }],
        ['a command becomes empty', (list: ReturnType<typeof commands>) => { list[0].command = ''; }],
        ['an empty command gets filled in', (list: ReturnType<typeof commands>) => { list[2].command = 'codex'; }],
        ['one is removed', (list: ReturnType<typeof commands>) => { list.splice(0, 1); }]
    ])('should need re-registering when %s', (_label, change) => {
        const edited = commands();
        change(edited);

        expect(sameRegistrations(quickCommandRegistrations(commands()), quickCommandRegistrations(edited))).toBe(false);
    });
});

describe('isDangerousCommand', () => {
    it.each([
        'claude --dangerously-skip-permissions',
        'claude --allow-dangerously-skip-permissions',
        'claude --permission-mode bypassPermissions',
        'claude --permission-mode=bypassPermissions',
        'agy --dangerously-skip-permissions',
        'agy --yolo',
        'codex --dangerously-bypass-approvals-and-sandbox',
        'codex resume --last --dangerously-bypass-approvals-and-sandbox',
        'codex --sandbox danger-full-access',
        'codex -s danger-full-access',
        'codex -c sandbox_mode="danger-full-access"',
        'opencode --auto',
        'opencode --continue --auto',
        'opencode --auto=true',
        // 透過 ollama launch 傳給 agent 的參數 (-- 之後) 一樣要警告
        'ollama launch claude -- --dangerously-skip-permissions',
        'ollama launch opencode -- --auto'
    ])('should flag %s', (command) => {
        expect(isDangerousCommand(command)).toBe(true);
    });

    it.each([
        'claude', 'claude --continue', 'claude --permission-mode acceptEdits', 'claude --permission-mode dontAsk',
        'agy', 'agy --continue', 'agy --mode=accept-edits', 'agy --sandbox',
        'codex', 'codex resume --last', 'codex --sandbox workspace-write', 'codex --approve-for-me',
        'opencode', 'opencode --continue', 'opencode --autosave', 'opencode --auto=false'
    ])('should not flag %s', (command) => {
        expect(isDangerousCommand(command)).toBe(false);
    });
});

describe('quick command settings', () => {
    it('should offer the Claude Code and Antigravity CLI templates by default', () => {
        expect(DEFAULT_SETTINGS.quickCommands.map(q => q.command)).toEqual([
            'claude', 'claude --continue', 'claude --dangerously-skip-permissions', 'claude --continue --dangerously-skip-permissions',
            'agy', 'agy --continue', 'agy --dangerously-skip-permissions', 'agy --continue --dangerously-skip-permissions'
        ]);
        expect(new Set(DEFAULT_SETTINGS.quickCommands.map(q => q.id)).size).toBe(8);
    });

    it('should keep the ids of the original defaults so existing hotkeys keep working', () => {
        const ids = DEFAULT_SETTINGS.quickCommands.map(q => q.id);
        expect(ids).toEqual(expect.arrayContaining(['claude', 'claude-continue', 'agy']));
    });

    it('should start quick commands from the vault root by default', () => {
        expect(DEFAULT_SETTINGS.quickCommandsFromVaultRoot).toBe(true);
        expect(mergeSettings({}).quickCommandsFromVaultRoot).toBe(true);
        expect(mergeSettings({ quickCommandsFromVaultRoot: false }).quickCommandsFromVaultRoot).toBe(false);
    });

    it('should give existing users the default quick commands', () => {
        const settings = mergeSettings({ shellPath: '/bin/zsh' });

        expect(settings.shellPath).toBe('/bin/zsh');
        expect(settings.quickCommands).toEqual(DEFAULT_SETTINGS.quickCommands);
    });

    it('should keep saved quick commands and not share objects with the defaults', () => {
        const saved = [{ id: 'x', name: 'Claude (skip)', command: 'claude --dangerously-skip-permissions' }];

        const settings = mergeSettings({ quickCommands: saved });
        settings.quickCommands[0].name = 'changed';
        const fresh = mergeSettings(null);
        fresh.quickCommands[0].name = 'changed too';

        expect(saved[0].name).toBe('Claude (skip)');
        expect(DEFAULT_SETTINGS.quickCommands[0].name).not.toBe('changed too');
    });

    it('should drop malformed quick commands from the saved data', () => {
        const settings = mergeSettings({
            quickCommands: [{ id: 'ok', name: 'ok', command: 'claude' }, { id: 5 }, null, 'agy'] as any
        });

        expect(settings.quickCommands).toEqual([{ id: 'ok', name: 'ok', command: 'claude' }]);
    });
});

describe('agent templates', () => {
    const template = (id: string) => AGENT_TEMPLATES.find(t => t.id === id)!;

    it('Claude Code: new session, continue, skip permissions, continue + skip permissions', () => {
        expect(template('claude').commands.map(c => c.command)).toEqual(['claude', 'claude --continue', 'claude --dangerously-skip-permissions', 'claude --continue --dangerously-skip-permissions']);
    });

    it('Antigravity CLI: new session, continue, skip permissions, continue + skip permissions', () => {
        expect(template('agy').commands.map(c => c.command)).toEqual(['agy', 'agy --continue', 'agy --dangerously-skip-permissions', 'agy --continue --dangerously-skip-permissions']);
    });

    // codex 0.160：繼續上次是 `resume --last` 子指令 (codex 的 -c 是 --config，不是 continue)
    it('Codex CLI: new session, resume last, bypass approvals and sandbox, resume + bypass', () => {
        expect(template('codex').commands.map(c => c.command)).toEqual(['codex', 'codex resume --last', 'codex --dangerously-bypass-approvals-and-sandbox', 'codex resume --last --dangerously-bypass-approvals-and-sandbox']);
    });

    // opencode 1.18：--continue 與 --auto (自動核准未明確拒絕的權限)
    it('opencode: new session, continue, auto-approve, continue + auto-approve', () => {
        expect(template('opencode').commands.map(c => c.command)).toEqual(['opencode', 'opencode --continue', 'opencode --auto', 'opencode --continue --auto']);
    });

    it('should mark exactly the permission-skipping presets as dangerous', () => {
        for (const t of AGENT_TEMPLATES.filter(t => t.id !== 'ollama')) {
            expect(t.commands.map(c => isDangerousCommand(c.command))).toEqual([false, false, true, true]);
        }
    });

    // ollama launch <agent> [-- 參數]：第一次啟動時選模型，之後沿用同一個 agent 上次的模型
    it('Ollama: Claude Code, Codex CLI and opencode with local or cloud models, new session and continue', () => {
        expect(template('ollama').commands.map(c => c.command)).toEqual([
            'ollama launch claude', 'ollama launch claude -- --continue',
            'ollama launch codex', 'ollama launch codex -- resume --last',
            'ollama launch opencode', 'ollama launch opencode -- --continue'
        ]);
    });

    // 本機小模型較容易誤用工具：預設不提供跳過權限確認的版本 (使用者仍可自行加上)
    it('Ollama presets should not skip permission prompts', () => {
        expect(template('ollama').commands.some(c => isDangerousCommand(c.command))).toBe(false);
    });

    it('Ollama presets should form one menu section', () => {
        expect(groupByProgram(template('ollama').commands)).toHaveLength(1);
    });

    it('should use ids that are unique across all templates', () => {
        const ids = AGENT_TEMPLATES.flatMap(t => t.commands.map(c => c.id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('should keep the defaults to Claude Code and Antigravity CLI so the menu stays short', () => {
        expect(DEFAULT_SETTINGS.quickCommands.every(q => /^(claude|agy)\b/.test(q.command))).toBe(true);
    });

    it('should append a template to an empty list using its stable ids', () => {
        const result = addTemplateCommands([], template('agy'), () => 'generated');

        expect(result.map(q => q.id)).toEqual(['agy', 'agy-continue', 'agy-skip-permissions', 'agy-continue-skip-permissions']);
    });

    it('should skip commands that are already in the list and not change existing entries', () => {
        const existing = [{ id: 'mine', name: 'My agy', command: 'agy' }];

        const result = addTemplateCommands(existing, template('agy'), () => 'generated');

        expect(result[0]).toBe(existing[0]);
        expect(result.map(q => q.command)).toEqual(['agy', 'agy --continue', 'agy --dangerously-skip-permissions', 'agy --continue --dangerously-skip-permissions']);
    });

    it('should generate a new id when the template id is already taken', () => {
        const existing = [{ id: 'claude', name: 'Something else', command: 'claude --model opus' }];
        let n = 0;

        const result = addTemplateCommands(existing, template('claude'), () => `generated-${++n}`);

        expect(result.find(q => q.command === 'claude')?.id).toBe('generated-1');
        expect(new Set(result.map(q => q.id)).size).toBe(result.length);
    });

    it('should not mutate the list it was given', () => {
        const existing: { id: string; name: string; command: string }[] = [];

        addTemplateCommands(existing, template('claude'), () => 'x');

        expect(existing).toEqual([]);
    });
});

describe('groupByProgram (menu sections)', () => {
    const q = (command: string) => ({ id: command, name: command, command });

    it('should group consecutive commands that start the same program', () => {
        const groups = groupByProgram([q('claude'), q('claude --continue'), q('agy'), q('agy --continue')]);

        expect(groups.map(g => g.map(c => c.command))).toEqual([['claude', 'claude --continue'], ['agy', 'agy --continue']]);
    });

    it('should keep the user\'s order instead of sorting', () => {
        const groups = groupByProgram([q('claude'), q('agy'), q('claude --continue')]);

        expect(groups.map(g => g.map(c => c.command))).toEqual([['claude'], ['agy'], ['claude --continue']]);
    });

    it('should ignore empty commands', () => {
        expect(groupByProgram([q('  '), q('agy')])).toEqual([[q('agy')]]);
    });
});

describe('default quick command (button sends it directly)', () => {
    const settingsWith = (defaultQuickCommandId: string) =>
        mergeSettings({ defaultQuickCommandId, quickCommands: [
            { id: 'a', name: 'A', command: 'claude --continue' },
            { id: 'empty', name: 'Empty', command: '   ' }
        ] });

    it('should have no default out of the box, so the button keeps showing the menu', () => {
        expect(DEFAULT_SETTINGS.defaultQuickCommandId).toBe('');
        expect(resolveDefaultQuickCommand(mergeSettings({}))).toBeNull();
    });

    it('should return the chosen quick command', () => {
        expect(resolveDefaultQuickCommand(settingsWith('a'))?.command).toBe('claude --continue');
    });

    it('should fall back to the menu when the default was deleted', () => {
        expect(resolveDefaultQuickCommand(settingsWith('deleted'))).toBeNull();
    });

    it('should fall back to the menu when the default command is empty', () => {
        expect(resolveDefaultQuickCommand(settingsWith('empty'))).toBeNull();
    });

    it('should ignore a malformed saved value', () => {
        expect(mergeSettings({ defaultQuickCommandId: 42 }).defaultQuickCommandId).toBe('');
    });
});
