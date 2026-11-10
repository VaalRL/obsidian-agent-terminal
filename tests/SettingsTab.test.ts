import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTerminalSettingTab } from '../src/ui/SettingsTab';
import { AgentTerminalSettings, CwdMode, mergeSettings } from '../src/core/settings';
import { EnvironmentService } from '../src/services/EnvironmentService';
import { AGENT_TEMPLATES } from '../src/core/agentTemplates';
import { BMC_URL } from '../src/core/constants';

// 設定頁改用 Obsidian 1.13 的宣告式設定 (getSettingDefinitions)：
// 這裡驗證設定清單的內容、visible 條件、讀寫對應、驗證與清單操作，畫面本身由 Obsidian 繪製

type Item = {
    type?: string;
    heading?: string;
    name?: string;
    desc?: string;
    items?: Item[];
    control?: { type: string; key: string; options?: Record<string, string>; validate?: (v: string) => unknown };
    render?: (setting: unknown, group: unknown) => void;
    visible?: boolean | (() => boolean);
    status?: 'warning' | null | (() => 'warning' | null);
    onDelete?: (index: number) => void;
    onReorder?: (from: number, to: number) => void;
    addItem?: { name: string; action: (el: unknown) => void };
    emptyState?: string;
};

/** 測試替身 (tests/__mocks__/obsidian.ts) 記錄的 update() / refreshDomState() 次數 */
interface TabCounters {
    updateCount: number;
    refreshCount: number;
}

function createTab(overrides: Partial<AgentTerminalSettings> = {}) {
    const settings: AgentTerminalSettings = { ...mergeSettings({}), shellPath: '/bin/zsh', ...overrides };
    const plugin = { settings, saveSettings: vi.fn(async () => {}) };
    // 測試只需要 app 能傳給 FolderSuggest
    const tab = new AgentTerminalSettingTab({} as never, plugin as never) as AgentTerminalSettingTab & TabCounters;
    return { tab, plugin };
}

/** 開啟設定頁：取得設定清單並等 shell 偵測完成 (偵測完成時會呼叫一次 update) */
async function openTab(overrides: Partial<AgentTerminalSettings> = {}) {
    const created = createTab(overrides);
    definitions(created.tab);
    await vi.waitFor(() => expect(created.tab.updateCount).toBe(1));
    return created;
}

function definitions(tab: AgentTerminalSettingTab): Item[] {
    return tab.getSettingDefinitions() as unknown as Item[];
}

/** 依名稱 (設定) 或標題 (群組) 在巢狀清單中找項目 */
function find(items: Item[], label: string): Item {
    const stack = [...items];
    while (stack.length) {
        const item = stack.shift()!;
        if (item.name === label || item.heading === label) return item;
        stack.push(...(item.items ?? []));
    }
    throw new Error(`No setting named "${label}"`);
}

function isVisible(item: Item): boolean {
    return typeof item.visible === 'function' ? item.visible() : item.visible !== false;
}

/** 記錄 render 呼叫內容的 Setting 替身 */
function fakeSetting() {
    const texts: { value: string; onChange?: (v: string) => void }[] = [];
    const buttons: { text: string; click?: () => unknown }[] = [];
    const links: { tag: string; options: { text?: string; href?: string; attr?: Record<string, string> } }[] = [];
    const divs: { text: string; cls?: string }[] = [];
    const setting = {
        texts, buttons, links, divs,
        descEl: {
            createDiv(options: { text?: string; cls?: string } = {}) {
                const div = { text: options.text ?? '', cls: options.cls, setText(t: string) { div.text = t; } };
                divs.push(div);
                return div;
            }
        },
        controlEl: {
            createEl(tag: string, options: { text?: string; href?: string; attr?: Record<string, string> }) {
                links.push({ tag, options });
                return {};
            }
        },
        setDesc() { return setting; },
        addText(cb: (text: unknown) => void) {
            const entry: { value: string; onChange?: (v: string) => void } = { value: '' };
            const text = {
                inputEl: { addClass() {} },
                setPlaceholder() { return text; },
                setValue(v: string) { entry.value = v; return text; },
                onChange(fn: (v: string) => void) { entry.onChange = fn; return text; }
            };
            texts.push(entry);
            cb(text);
            return setting;
        },
        addButton(cb: (button: unknown) => void) {
            const entry: { text: string; click?: () => unknown } = { text: '' };
            const button = {
                setButtonText(t: string) { entry.text = t; return button; },
                setCta() { return button; },
                onClick(fn: () => unknown) { entry.click = fn; return button; }
            };
            buttons.push(entry);
            cb(button);
            return setting;
        }
    };
    return setting;
}

beforeEach(() => {
    vi.spyOn(EnvironmentService, 'detectShellPresets').mockResolvedValue([
        { name: 'zsh', path: '/bin/zsh' },
        { name: 'bash', path: '/bin/bash' }
    ]);
    vi.spyOn(EnvironmentService, 'validateShellPath').mockImplementation(async (p: string) => p === '/opt/fish');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('AgentTerminalSettingTab (declarative settings)', () => {
    it('should make every setting searchable by name', () => {
        const { tab } = createTab();
        const items = definitions(tab);

        for (const name of ['Shell', 'Default startup directory', 'Auto-sync directory', 'Start from the vault root',
            'Button action', 'Status', 'Buy me a coffee']) {
            expect(find(items, name)).toBeDefined();
        }
        expect(find(items, 'Quick commands').type).toBe('group');
        expect(find(items, 'Obsidian CLI for AI agents').type).toBe('group');
    });

    describe('shell', () => {
        it('should list detected shells after detection and refresh the tab', async () => {
            const { tab } = createTab();
            expect(find(definitions(tab), 'Shell').desc).toBe('Detecting installed shells…');

            await vi.waitFor(() => expect(tab.updateCount).toBe(1));
            const shell = find(definitions(tab), 'Shell');

            expect(shell.control?.options).toEqual({
                '/bin/zsh': 'zsh (/bin/zsh)',
                '/bin/bash': 'bash (/bin/bash)',
                __custom__: 'Custom path…'
            });
            expect(tab.getControlValue('shellChoice')).toBe('/bin/zsh');
        });

        it('should detect shells only once while the tab is open, and again in the background after it is hidden', async () => {
            const { tab } = await openTab();
            definitions(tab);
            expect(EnvironmentService.detectShellPresets).toHaveBeenCalledTimes(1);

            tab.hide();
            expect(EnvironmentService.detectShellPresets).toHaveBeenCalledTimes(2);
            await vi.waitFor(() => expect(tab.updateCount).toBe(2));
        });

        // Obsidian 重新開啟設定頁時沿用上次 update() 的設定清單，不一定再呼叫 getSettingDefinitions()：
        // 隱藏後仍要讀得到偵測結果，否則下拉選單會誤顯示「Custom path…」
        it('should keep showing the detected shell after the tab is hidden', async () => {
            const { tab } = await openTab();

            tab.hide();

            expect(tab.getControlValue('shellChoice')).toBe('/bin/zsh');
            expect(isVisible(find(definitions(tab), 'Custom shell path'))).toBe(false);
        });

        it('should save a picked shell', async () => {
            const { tab, plugin } = createTab();

            await tab.setControlValue('shellChoice', '/bin/bash');

            expect(plugin.settings.shellPath).toBe('/bin/bash');
            expect(plugin.saveSettings).toHaveBeenCalled();
        });

        it('should show the custom path input for "Custom path…" without changing the saved shell', async () => {
            const { tab, plugin } = await openTab();
            const custom = find(definitions(tab), 'Custom shell path');
            expect(isVisible(custom)).toBe(false);

            await tab.setControlValue('shellChoice', '__custom__');

            expect(isVisible(custom)).toBe(true);
            expect(tab.getControlValue('shellChoice')).toBe('__custom__');
            expect(plugin.settings.shellPath).toBe('/bin/zsh');
            expect(plugin.saveSettings).not.toHaveBeenCalled();
            expect(tab.refreshCount).toBeGreaterThan(0);
        });

        it('should show the custom path input when the saved shell is not a detected one', async () => {
            const { tab } = await openTab({ shellPath: '/opt/fish' });

            expect(tab.getControlValue('shellChoice')).toBe('__custom__');
            expect(isVisible(find(definitions(tab), 'Custom shell path'))).toBe(true);
        });

        it('should reject a custom shell path that is not executable, keeping the previous shell', async () => {
            const { tab } = createTab();
            const validate = find(definitions(tab), 'Custom shell path').control!.validate!;

            expect(await validate('/nope')).toMatch(/Invalid path/);
            expect(await validate(' /opt/fish ')).toBeFalsy();
        });

        it('should save a valid custom shell path trimmed', async () => {
            const { tab, plugin } = createTab();

            await tab.setControlValue('shellPath', ' /opt/fish ');

            expect(plugin.settings.shellPath).toBe('/opt/fish');
        });
    });

    describe('startup directory', () => {
        it('should show the custom path only for the custom path mode', async () => {
            const { tab, plugin } = createTab();
            const customPath = find(definitions(tab), 'Custom path');
            expect(isVisible(customPath)).toBe(false);

            await tab.setControlValue('cwdMode', CwdMode.CustomPath);

            expect(plugin.settings.cwdMode).toBe(CwdMode.CustomPath);
            expect(isVisible(customPath)).toBe(true);
            expect(tab.refreshCount).toBeGreaterThan(0);
        });

        it('should save the typed custom path after a pause', async () => {
            vi.useFakeTimers();
            const { tab, plugin } = createTab({ cwdMode: CwdMode.CustomPath, customCwdPath: 'notes' });
            const setting = fakeSetting();
            find(definitions(tab), 'Custom path').render!(setting, {});
            expect(setting.texts[0].value).toBe('notes');

            setting.texts[0].onChange!('/tmp/work');
            expect(plugin.settings.customCwdPath).toBe('/tmp/work');
            expect(plugin.saveSettings).not.toHaveBeenCalled();

            vi.advanceTimersByTime(400);
            expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
        });
    });

    describe('quick commands', () => {
        const commands = [
            { id: 'a', name: 'Claude', command: 'claude' },
            { id: 'b', name: '', command: 'codex' },
            { id: 'c', name: 'Empty', command: '  ' }
        ];

        it('should offer the menu and every non-empty command as the button action', () => {
            const { tab } = createTab({ quickCommands: commands.map(q => ({ ...q })) });

            expect(find(definitions(tab), 'Button action').control?.options).toEqual({
                '': 'Show the menu',
                a: 'Run: Claude',
                b: 'Run: codex'
            });
        });

        it('should read the effective default command', () => {
            const { tab } = createTab({ quickCommands: commands.map(q => ({ ...q })), defaultQuickCommandId: 'gone' });

            expect(tab.getControlValue('defaultQuickCommandId')).toBe('');
        });

        it('should list each command as a page named after it, showing the command', () => {
            const { tab } = createTab({ quickCommands: commands.map(q => ({ ...q })) });
            const list = find(definitions(tab), 'Commands');

            expect(list.type).toBe('list');
            expect(list.items!.map(item => item.type)).toEqual(['page', 'page', 'page']);
            expect(list.items!.map(item => item.name)).toEqual(['Claude', 'codex', 'Empty']);
            expect(list.items!.map(item => item.desc)).toEqual(['claude', 'codex', '  ']);
            expect(list.emptyState).toBeTruthy();
        });

        it('should find a command by its name in settings search, not by the fields on its page', () => {
            const { tab } = createTab({ quickCommands: commands.map(q => ({ ...q })) });
            const page = find(definitions(tab), 'Commands').items![0] as Item & { searchable?: boolean };

            expect(page.searchable).not.toBe(false);
            expect(page.items!.map(item => (item as { searchable?: boolean }).searchable)).toEqual([false, false, false]);
        });

        it('should add, delete and reorder commands, then refresh the tab', async () => {
            const { tab, plugin } = await openTab({ quickCommands: commands.map(q => ({ ...q })) });
            const list = find(definitions(tab), 'Commands');

            list.onReorder!(0, 2);
            await vi.waitFor(() => expect(tab.updateCount).toBe(2));
            expect(plugin.settings.quickCommands.map(q => q.id)).toEqual(['b', 'c', 'a']);

            list.onDelete!(1);
            await vi.waitFor(() => expect(tab.updateCount).toBe(3));
            expect(plugin.settings.quickCommands.map(q => q.id)).toEqual(['b', 'a']);

            list.addItem!.action({});
            await vi.waitFor(() => expect(tab.updateCount).toBe(4));
            expect(plugin.settings.quickCommands).toHaveLength(3);
            expect(plugin.settings.quickCommands[2]).toMatchObject({ name: '', command: '' });
            expect(plugin.settings.quickCommands[2].id).toMatch(/^qc-/);
            expect(plugin.saveSettings).toHaveBeenCalledTimes(3);
        });

        it('should edit a command on its page and save after a pause', async () => {
            const { tab, plugin } = await openTab({ quickCommands: commands.map(q => ({ ...q })) });
            vi.useFakeTimers();
            const page = find(definitions(tab), 'Commands').items![0];
            const [nameField, commandField] = page.items!;
            expect(nameField.control?.type).toBe('text');
            expect(tab.getControlValue(nameField.control!.key)).toBe('Claude');
            expect(tab.getControlValue(commandField.control!.key)).toBe('claude');

            await tab.setControlValue(commandField.control!.key, 'claude --continue');
            await tab.setControlValue(nameField.control!.key, 'Claude (continue)');

            expect(plugin.settings.quickCommands[0]).toMatchObject({ name: 'Claude (continue)', command: 'claude --continue' });
            expect(plugin.saveSettings).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(400);
            expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
            // 存檔後重建清單，讓清單上的名稱與指令跟著更新 (第 1 次是 shell 偵測完成)
            expect(tab.updateCount).toBe(2);
        });

        it('should mark a permission-skipping command with a warning, on the list and on its page', async () => {
            const { tab } = createTab({ quickCommands: commands.map(q => ({ ...q })) });
            const page = find(definitions(tab), 'Commands').items![0];
            const status = page.status as () => 'warning' | null;
            const warningRow = page.items!.find(item => !item.control)!;
            expect(status()).toBeNull();
            expect(isVisible(warningRow)).toBe(false);

            await tab.setControlValue(page.items![1].control!.key, 'claude --dangerously-skip-permissions');

            expect(status()).toBe('warning');
            expect(isVisible(warningRow)).toBe(true);
            expect(warningRow.desc).toMatch(/without asking for permission/);
        });

        it('should ignore edits to a command that no longer exists', async () => {
            const { tab, plugin } = createTab({ quickCommands: commands.map(q => ({ ...q })) });

            await tab.setControlValue('quickCommand:gone:name', 'x');

            expect(plugin.settings.quickCommands.map(q => q.name)).toEqual(['Claude', '', 'Empty']);
            expect(tab.getControlValue('quickCommand:gone:name')).toBe('');
        });

        it('should add an agent\'s presets from its row', async () => {
            const { tab, plugin } = await openTab({ quickCommands: [] });
            const codex = AGENT_TEMPLATES.find(t => t.id === 'codex')!;
            const setting = fakeSetting();
            find(definitions(tab), `${codex.label} presets`).render!(setting, {});

            await setting.buttons[0].click!();

            expect(plugin.settings.quickCommands.map(q => q.command)).toEqual(codex.commands.map(c => c.command));
            expect(plugin.saveSettings).toHaveBeenCalled();
            expect(tab.updateCount).toBe(2);
        });

        it('should explain what Ollama models need on the Ollama row', () => {
            const { tab } = createTab();

            expect(find(definitions(tab), 'Ollama presets').desc).toMatch(/supports tools/);
        });
    });

    describe('other settings', () => {
        it('should save simple controls through the plugin', async () => {
            const { tab, plugin } = createTab();

            await tab.setControlValue('autoSyncCwd', true);
            await tab.setControlValue('quickCommandsFromVaultRoot', false);
            await tab.setControlValue('defaultQuickCommandId', 'claude');

            expect(plugin.settings).toMatchObject({ autoSyncCwd: true, quickCommandsFromVaultRoot: false, defaultQuickCommandId: 'claude' });
            expect(plugin.saveSettings).toHaveBeenCalledTimes(3);
            expect(tab.getControlValue('autoSyncCwd')).toBe(true);
        });

        it('should link the support page as a plain external link', () => {
            const { tab } = createTab();
            const setting = fakeSetting();
            find(definitions(tab), 'Buy me a coffee').render!(setting, {});

            expect(setting.links).toEqual([{
                tag: 'a',
                options: expect.objectContaining({
                    href: BMC_URL,
                    attr: expect.objectContaining({ target: '_blank', rel: 'noopener noreferrer' })
                })
            }]);
        });

        it('should show the Obsidian CLI status and re-check it on request', async () => {
            const { tab } = await openTab();
            const setting = fakeSetting();
            find(definitions(tab), 'Status').render!(setting, {});

            expect(setting.divs[0].text).not.toBe('');
            setting.buttons[0].click!();
            expect(tab.updateCount).toBe(2);
        });
    });
});
