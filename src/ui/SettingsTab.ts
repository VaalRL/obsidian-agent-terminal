import { App, Platform, PluginSettingTab, requireApiVersion } from 'obsidian';
import electron from 'electron';
import type { Setting, SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionList, SettingDefinitionPage, TextComponent } from 'obsidian';
import type AgentTerminalPlugin from '../main';
import { EnvironmentService, ShellPreset } from '../services/EnvironmentService';
import { PathResolver } from '../services/PathResolver';
import { detectObsidianCli, currentCliHost, MIN_CLI_VERSION } from '../services/ObsidianCli';
import { CwdMode, QuickCommand } from '../core/settings';
import { isDangerousCommand, resolveDefaultQuickCommand } from '../core/QuickCommands';
import { AGENT_TEMPLATES, AgentTemplate, addTemplateCommands } from '../core/agentTemplates';
import { FolderSuggest } from './FolderSuggest';
import { BMC_URL } from '../core/constants';

const CUSTOM_SHELL_OPTION = '__custom__';
/** 「Shell」下拉選單的虛擬設定鍵：值是偵測到的 shell 路徑或 CUSTOM_SHELL_OPTION，實際存在 shellPath */
const SHELL_CHOICE_KEY = 'shellChoice';
const SAVE_DELAY_MS = 400;
/** quick command 子頁面欄位的設定鍵：quickCommand:<id>:name / quickCommand:<id>:command */
const QUICK_COMMAND_KEY = /^quickCommand:(.+):(name|command)$/;

const INVALID_SHELL_MESSAGE = '⚠️ Invalid path: the file does not exist or is not executable. The previous shell is kept.';
const DANGEROUS_COMMAND_MESSAGE = '⚠️ This command lets the agent run commands and edit files without asking for permission.';

const DEFAULT_PRESET_DESCRIPTION = 'Adds commands to start a new session and to continue the last one, '
    + 'and the variants that skip permission prompts. Commands you already have are not added again.';
// Ollama 預設的前提：模型要支援工具才能改檔案、執行指令 (`ollama run` 只是聊天)
const PRESET_DESCRIPTIONS: Record<string, string> = {
    ollama: 'Starts Claude Code, Codex CLI or opencode with a local or Ollama cloud model through "ollama launch" '
        + '(you pick the model the first time). To let the agent edit files and run commands, choose a model that '
        + 'supports tools and set its context length to 64k or more; "ollama run" only chats.'
};

interface FolderDialog {
    showOpenDialog(options: { properties: string[]; defaultPath?: string }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/**
 * 取得 Electron 原生資料夾選擇對話框。Obsidian 沒有正式 API，取不到時回傳 null (不顯示「Browse…」按鈕)。
 */
function getFolderDialog(): FolderDialog | null {
    return (electron as { remote?: { dialog?: FolderDialog } } | undefined)?.remote?.dialog ?? null;
}

/** 固定 id：Obsidian 指令 id 依此產生，改名不會失去快捷鍵 */
function newQuickCommandId(): string {
    return `qc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 設定頁 (Obsidian 1.13 宣告式設定 API)：getSettingDefinitions() 描述所有設定，由 Obsidian 繪製並納入設定搜尋。
 * 一般控制項透過 getControlValue / setControlValue 讀寫 plugin.settings (存檔一律經 plugin.saveSettings，
 * 才會同步重新註冊 quick command 指令與更新已開啟的終端機)；需要自訂畫面的項目使用 render。
 */
export class AgentTerminalSettingTab extends PluginSettingTab {
    plugin: AgentTerminalPlugin;
    private saveTimeout: number | null = null;
    // 延遲存檔完成後是否要重建設定清單 (quick command 改名或改指令時，清單上的文字要跟著更新)
    private updateAfterSave = false;
    // 偵測到的 shell (null 表示尚未偵測)；每次開啟設定頁重新偵測 (使用者可能剛安裝了新的 shell)
    private shellPresets: ShellPreset[] | null = null;
    private detectingShells = false;
    // 使用者在下拉選單選了「Custom path…」
    private customShellMode = false;

    constructor(app: App, plugin: AgentTerminalPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        this.detectShells();
        return [
            this.terminalGroup(),
            this.quickCommandsGroup(),
            this.quickCommandList(),
            this.presetsGroup(),
            this.obsidianCliGroup(),
            this.supportGroup()
        ];
    }

    getControlValue(key: string): unknown {
        const settings = this.plugin.settings;
        const field = this.quickCommandField(key);
        if (field) return field.quickCommand?.[field.name] ?? '';
        switch (key) {
            case SHELL_CHOICE_KEY:
                return this.showCustomShellInput() || !this.isDetectedShell() ? CUSTOM_SHELL_OPTION : settings.shellPath;
            case 'defaultQuickCommandId':
                return resolveDefaultQuickCommand(settings)?.id ?? '';
            default:
                return (settings as unknown as Record<string, unknown>)[key];
        }
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const settings = this.plugin.settings;
        const field = this.quickCommandField(key);
        if (field) {
            if (!field.quickCommand) return;
            field.quickCommand[field.name] = typeof value === 'string' ? value : '';
            this.refreshDomState(); // 子頁面上的權限警告
            this.debouncedSave(true);
            return;
        }
        switch (key) {
            case SHELL_CHOICE_KEY:
                this.customShellMode = value === CUSTOM_SHELL_OPTION;
                if (!this.customShellMode && typeof value === 'string') {
                    settings.shellPath = value;
                    await this.plugin.saveSettings();
                }
                this.refreshDomState(); // 顯示或隱藏「Custom shell path」
                return;
            case 'shellPath': {
                // 只有通過 validate 的路徑才會進來；無效路徑不存檔，保留原本的 shell
                const shellPath = typeof value === 'string' ? value.trim() : '';
                if (!shellPath || shellPath === settings.shellPath) return;
                settings.shellPath = shellPath;
                await this.plugin.saveSettings();
                return;
            }
            case 'cwdMode':
                settings.cwdMode = value as CwdMode;
                await this.plugin.saveSettings();
                this.refreshDomState(); // 顯示或隱藏「Custom path」
                return;
            case 'autoSyncCwd':
            case 'quickCommandsFromVaultRoot':
                settings[key] = value === true;
                await this.plugin.saveSettings();
                return;
            case 'defaultQuickCommandId':
                settings.defaultQuickCommandId = typeof value === 'string' ? value : '';
                await this.plugin.saveSettings();
                return;
        }
    }

    hide(): void {
        super.hide();
        this.customShellMode = false;
        // 下次開啟前在背景重新偵測 (使用者可能剛安裝了新的 shell)。
        // 不清空上次的結果：Obsidian 重新開啟設定頁時沿用上次 update() 的清單，getControlValue 仍需讀得到偵測結果
        this.detectShells(true);
    }

    private debouncedSave(updateAfterSave = false): void {
        this.updateAfterSave ||= updateAfterSave;
        if (this.saveTimeout) window.clearTimeout(this.saveTimeout);
        this.saveTimeout = window.setTimeout(() => {
            const shouldUpdate = this.updateAfterSave;
            this.updateAfterSave = false;
            void this.plugin.saveSettings().then(() => { if (shouldUpdate) this.update(); });
        }, SAVE_DELAY_MS);
    }

    private quickCommandField(key: string): { quickCommand: QuickCommand | undefined; name: 'name' | 'command' } | null {
        const match = QUICK_COMMAND_KEY.exec(key);
        if (!match) return null;
        return {
            quickCommand: this.plugin.settings.quickCommands.find(q => q.id === match[1]),
            name: match[2] as 'name' | 'command'
        };
    }

    /** 非同步偵測已安裝的 shell，完成後以 update() 重建設定清單 (下拉選單選項)；force 時即使已有結果也重新偵測 */
    private detectShells(force = false): void {
        if (this.detectingShells || (this.shellPresets !== null && !force)) return;
        this.detectingShells = true;
        void EnvironmentService.detectShellPresets()
            .catch((): ShellPreset[] => [])
            .then((presets) => {
                this.detectingShells = false;
                this.shellPresets = presets;
                this.update();
            });
    }

    private isDetectedShell(): boolean {
        return (this.shellPresets ?? []).some(preset => preset.path === this.plugin.settings.shellPath);
    }

    private showCustomShellInput(): boolean {
        return this.customShellMode || (this.shellPresets !== null && !this.isDetectedShell());
    }

    private terminalGroup(): SettingDefinitionGroup {
        const shellOptions: Record<string, string> = {};
        for (const preset of this.shellPresets ?? []) {
            shellOptions[preset.path] = `${preset.name} (${preset.path})`;
        }
        shellOptions[CUSTOM_SHELL_OPTION] = 'Custom path…';

        return {
            type: 'group',
            items: [
                {
                    name: 'Shell',
                    desc: this.shellPresets === null
                        ? 'Detecting installed shells…'
                        : 'Choose an installed shell, or "Custom path…" to enter one yourself.',
                    control: { type: 'dropdown', key: SHELL_CHOICE_KEY, options: shellOptions }
                },
                {
                    name: 'Custom shell path',
                    desc: 'Absolute path to the shell executable.',
                    visible: () => this.showCustomShellInput(),
                    control: {
                        type: 'text',
                        key: 'shellPath',
                        placeholder: `Example: ${EnvironmentService.detectDefaultShell()}`,
                        validate: async (value: string) =>
                            (await EnvironmentService.validateShellPath(value.trim())) ? undefined : INVALID_SHELL_MESSAGE
                    }
                },
                {
                    name: 'Default startup directory',
                    desc: 'Determines where the terminal starts by default.',
                    control: {
                        type: 'dropdown',
                        key: 'cwdMode',
                        options: {
                            [CwdMode.VaultRoot]: 'Vault root',
                            [CwdMode.CurrentFile]: 'Current note directory',
                            [CwdMode.CustomPath]: 'Custom fixed path'
                        }
                    }
                },
                {
                    name: 'Custom path',
                    desc: 'Pick a vault folder from the suggestions, browse for any folder, or type an absolute path.',
                    visible: () => this.plugin.settings.cwdMode === CwdMode.CustomPath,
                    render: (setting) => this.renderCustomPath(setting)
                },
                {
                    name: 'Auto-sync directory',
                    desc: Platform.isWin
                        ? 'Not available on Windows: the terminal cannot tell whether a program (such as an AI CLI) is running, so "cd" is never sent automatically. Use the "Locate to current file" button instead.'
                        : 'Automatically "cd" to the current note\'s folder when you switch notes. Only runs while the shell is waiting for a command, so it never types into running programs such as AI CLIs or vim.',
                    control: { type: 'toggle', key: 'autoSyncCwd' }
                }
            ]
        };
    }

    /** 自訂啟動路徑：可輸入 vault 外的絕對路徑，並提供 vault 資料夾建議與原生資料夾選擇對話框 */
    private renderCustomPath(setting: Setting): void {
        const input: { text?: TextComponent } = {};
        setting.addText(text => {
            input.text = text;
            // 輸入時建議 Vault 內的資料夾 (選取後會觸發 input 事件 → onChange)
            new FolderSuggest(this.app, text.inputEl);
            text
                .setPlaceholder('Example: /Users/name/projects')
                .setValue(this.plugin.settings.customCwdPath)
                .onChange((value) => {
                    this.plugin.settings.customCwdPath = value;
                    this.debouncedSave();
                });
        });

        const dialog = getFolderDialog();
        if (!dialog) return;

        setting.addButton(button => button
            .setButtonText('Browse…')
            .onClick(async () => {
                const result = await dialog.showOpenDialog({
                    properties: ['openDirectory'],
                    defaultPath: PathResolver.resolveCwd(this.app, this.plugin.settings)
                });
                const folder = result.filePaths[0];
                if (result.canceled || !folder) return;

                this.plugin.settings.customCwdPath = folder;
                input.text?.setValue(folder);
                await this.plugin.saveSettings();
            }));
    }

    private quickCommandsGroup(): SettingDefinitionGroup {
        const actionOptions: Record<string, string> = { '': 'Show the menu' };
        for (const quickCommand of this.plugin.settings.quickCommands) {
            if (!quickCommand.command.trim()) continue;
            actionOptions[quickCommand.id] = `Run: ${quickCommand.name || quickCommand.command}`;
        }

        return {
            type: 'group',
            heading: 'Quick commands',
            items: [
                {
                    name: 'How quick commands work',
                    desc: 'Send a command, such as starting an AI agent, from the bot button in the terminal header, the command palette, '
                        + 'or a hotkey (Settings → Hotkeys, search "Run quick command"). '
                        + 'A command is only sent while the shell is waiting for input, so it never types into a running program.'
                },
                {
                    name: 'Start from the vault root',
                    desc: 'Change to the vault root before running a quick command. AI agents look for their previous session '
                        + 'and for instruction files such as CLAUDE.md or GEMINI.md relative to the folder they start in.',
                    control: { type: 'toggle', key: 'quickCommandsFromVaultRoot' }
                },
                {
                    name: 'Button action',
                    desc: 'What the bot button does. With a default command it runs that command directly; '
                        + 'use the arrow next to it or right-click it for the full menu. '
                        + 'The command "Run default button action" can also be bound to a hotkey.',
                    control: { type: 'dropdown', key: 'defaultQuickCommandId', options: actionOptions }
                }
            ]
        };
    }

    /**
     * quick command 清單：Obsidian 提供刪除、拖曳排序與新增按鈕。
     * 每個指令是一個子頁面：清單上顯示名稱與指令 (跳過權限確認的標上警告)，點進去編輯名稱與指令。
     */
    private quickCommandList(): SettingDefinitionList {
        return {
            type: 'list',
            heading: 'Commands',
            emptyState: 'No quick commands yet. Add one with the + button, or add an agent\'s presets below.',
            items: this.plugin.settings.quickCommands.map((quickCommand): SettingDefinitionPage => ({
                type: 'page',
                name: quickCommand.name || quickCommand.command || 'New quick command',
                desc: quickCommand.command,
                status: () => isDangerousCommand(quickCommand.command) ? 'warning' : null,
                // 設定搜尋以指令名稱找到這一頁；頁內欄位不列入搜尋，否則每個指令都會多出「Name」等結果
                items: [
                    {
                        name: 'Name',
                        desc: 'Shown in the bot menu, and in the command palette as "Run quick command: …".',
                        searchable: false,
                        control: { type: 'text', key: `quickCommand:${quickCommand.id}:name`, placeholder: 'Name' }
                    },
                    {
                        name: 'Command',
                        desc: 'Typed into the terminal when you run it, for example claude --continue.',
                        searchable: false,
                        control: { type: 'text', key: `quickCommand:${quickCommand.id}:command`, placeholder: 'Command, e.g. claude' }
                    },
                    {
                        name: 'Skips permission prompts',
                        desc: DANGEROUS_COMMAND_MESSAGE,
                        searchable: false,
                        visible: () => isDangerousCommand(quickCommand.command)
                    }
                ]
            })),
            onDelete: (index) => this.changeQuickCommands(list => { list.splice(index, 1); }),
            onReorder: (from, to) => this.changeQuickCommands(list => {
                const [moved] = list.splice(from, 1);
                if (moved) list.splice(to, 0, moved);
            }),
            addItem: {
                name: 'Add quick command',
                action: () => this.changeQuickCommands(list => { list.push({ id: newQuickCommandId(), name: '', command: '' }); })
            }
        };
    }

    /** 增刪或排序 quick command 後存檔，並重建設定清單 (清單項目與「Button action」選項) */
    private changeQuickCommands(change: (list: QuickCommand[]) => void): void {
        change(this.plugin.settings.quickCommands);
        void this.plugin.saveSettings().then(() => this.update());
    }

    /** 各 agent 的範本：一鍵加入「新對話 / 繼續上次 / 跳過權限確認 / 兩者並用」，已有的指令不重複加入 */
    private presetsGroup(): SettingDefinitionGroup {
        return {
            type: 'group',
            heading: 'Agent presets',
            items: AGENT_TEMPLATES.map(template => ({
                name: `${template.label} presets`,
                desc: PRESET_DESCRIPTIONS[template.id] ?? DEFAULT_PRESET_DESCRIPTION,
                render: (setting: Setting) => {
                    setting.addButton(button => button
                        .setButtonText('Add')
                        .onClick(() => this.addPresets(template)));
                }
            }))
        };
    }

    private async addPresets(template: AgentTemplate): Promise<void> {
        this.plugin.settings.quickCommands = addTemplateCommands(this.plugin.settings.quickCommands, template, newQuickCommandId);
        await this.plugin.saveSettings();
        this.update();
    }

    /** Obsidian 官方 CLI 的狀態：讓終端機裡的 AI agent 控制 Obsidian (開今日筆記、切換檢視模式…) */
    private obsidianCliGroup(): SettingDefinitionGroup {
        return {
            type: 'group',
            heading: 'Obsidian CLI for AI agents',
            items: [{
                name: 'Status',
                desc: 'With the official Obsidian CLI, AI agents in the terminal can control Obsidian, for example open '
                    + 'today\'s daily note or switch to reading view. Run "Bootstrap AI core" to teach them how (obsidian-cli skill).',
                render: (setting: Setting) => {
                    // 每次繪製時重新偵測；「Check again」以 update() 重新繪製
                    const status = detectObsidianCli(currentCliHost(requireApiVersion(MIN_CLI_VERSION)));
                    const description = {
                        available: status.state === 'available' && status.onPath
                            ? `✅ Available at ${status.path}.`
                            : `✅ Available at ${status.state === 'available' ? status.path : ''}. Agent Terminal adds its folder to the terminal's PATH, so agents can use it without restarting Obsidian.`,
                        'not-registered': '⚠️ Not enabled. Turn on Settings → General → Command line interface and register it, then restart the terminal.',
                        outdated: `⚠️ Needs Obsidian ${MIN_CLI_VERSION} or later. Update Obsidian to let AI agents control it.`
                    }[status.state];

                    setting.descEl.createDiv({
                        text: description,
                        cls: status.state === 'available' ? '' : 'agent-terminal-warning'
                    });
                    setting.addButton(button => button
                        .setButtonText('Check again')
                        .onClick(() => this.update()));
                }
            }]
        };
    }

    /** 贊助連結：只是一般連結 (不載入遠端圖片或程式)，由瀏覽器開啟 */
    private supportGroup(): SettingDefinitionGroup {
        return {
            type: 'group',
            heading: 'Support',
            items: [{
                name: 'Buy me a coffee',
                desc: 'Agent Terminal is free and open source. If it saves you time, you can support its development.',
                render: (setting: Setting) => {
                    setting.controlEl.createEl('a', {
                        text: 'Open support page',
                        href: BMC_URL,
                        cls: 'agent-terminal-support-link',
                        attr: {
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            'aria-label': 'Support the developer on Buy Me a Coffee'
                        }
                    });
                }
            }]
        };
    }
}
