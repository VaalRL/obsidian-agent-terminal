import { Notice, Plugin, TFile, FileSystemAdapter, requestUrl } from 'obsidian';
import { AgentTerminalSettings, mergeSettings } from './core/settings';
import { AgentTerminalSettingTab } from './ui/SettingsTab';
import { EnvironmentService } from './services/EnvironmentService';
import { TerminalManager } from './core/TerminalManager';
import { quickCommandRegistrations, sameRegistrations, QuickCommandRegistration } from './core/QuickCommands';
import { TerminalView, TERMINAL_VIEW_TYPE } from './ui/TerminalView';
import { PathResolver } from './services/PathResolver';
import { PtyService } from './services/PtyService';
import { ContextService } from './services/ContextService';
import * as path from 'path';
import { NativeInstaller } from './services/NativeInstaller';
import { ConfirmModal } from './ui/ConfirmModal';
import bridgeSource from 'virtual:bridge-source';
import nativeManifest from 'virtual:native-manifest';

// node-pty 下載檔發佈在此 repo 的 GitHub release (tag = manifest.json 的 version)
const RELEASE_REPO = 'VaalRL/obsidian-agent-terminal';

export default class AgentTerminalPlugin extends Plugin {
    declare settings: AgentTerminalSettings;
    terminalManager!: TerminalManager;
    nativeInstaller: NativeInstaller | null = null;
    private registeredQuickCommands: QuickCommandRegistration[] = [];

    async onload() {
        await this.loadSettings();

        // 解決 node-pty 載入問題：寫出外部橋接器，並準備 node-pty 的自動下載
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            const basePath = this.app.vault.adapter.getBasePath();
            const pluginDir = path.join(basePath, this.manifest.dir ?? '');
            PtyService.initBridge(pluginDir, bridgeSource);
            this.nativeInstaller = new NativeInstaller({
                pluginDir,
                manifest: nativeManifest,
                releaseUrl: `https://github.com/${RELEASE_REPO}/releases/download/${this.manifest.version}`,
                // requestUrl 不受 CORS 限制，且會跟隨 GitHub release 的轉址
                download: async (url) => (await requestUrl({ url })).arrayBuffer
            });
        }

        // 若無設定，自動偵測預設 shell
        if (!this.settings.shellPath) {
            this.settings.shellPath = EnvironmentService.detectDefaultShell();
            await this.saveSettings();
        }

        this.terminalManager = new TerminalManager(this.app, this.settings);

        // 註冊 View
        this.registerView(
            TERMINAL_VIEW_TYPE,
            (leaf) => new TerminalView(leaf, this.settings, PathResolver.resolveCwd(this.app, this.settings), this.nativeInstaller)
        );

        // 註冊 Ribbon 圖示 (快速開啟)
        this.addRibbonIcon('terminal', 'Open terminal', () => {
            void this.terminalManager.activateTerminalView();
        });

        // 註冊指令 (Command Palette)
        this.addCommand({
            id: 'open-terminal',
            name: 'Open terminal',
            callback: () => {
                void this.terminalManager.activateTerminalView();
            }
        });

        this.registerQuickCommands();

        this.addCommand({
            id: 'run-default-quick-command',
            name: 'Run default quick command',
            callback: () => {
                void this.terminalManager.runDefaultQuickCommand().then((result) => {
                    if (result === 'no-default') new Notice('Choose a default quick command in the Agent Terminal settings first.');
                });
            }
        });

        this.addCommand({
            id: 'bootstrap-ai-core',
            name: 'Bootstrap AI core',
            callback: () => {
                void ContextService.performBootstrap(this.app, (request) => ConfirmModal.ask(this.app, request));
            }
        });

        // 註冊設定面板
        this.addSettingTab(new AgentTerminalSettingTab(this.app, this));

        // 註冊編輯器右鍵選單 (將選取文字傳送至 Terminal)
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                const selection = editor.getSelection();
                if (selection) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Run in terminal')
                            .setIcon('terminal')
                            .onClick(() => {
                                void this.terminalManager.runInTerminal(selection).then((result) => {
                                    if (result === 'unavailable') {
                                        new Notice('The terminal is not ready. Check the message in the terminal, then try again.');
                                    }
                                });
                            });
                    });
                }
            })
        );

        // 監聽檔案切換事件，觸發自動跟隨
        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile | null) => {
                if (file && this.settings.autoSyncCwd) {
                    void this.terminalManager.syncCwd();
                }
            })
        );
    }

    onunload() {
        // Dispose all open terminal sessions to prevent zombie bridge processes
        const leaves = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
        for (const leaf of leaves) {
            // 延遲載入 (尚未開過) 的分頁沒有 TerminalView，也就沒有要結束的 bridge
            const view = TerminalManager.terminalViewOf(leaf);
            if (view?.ptyService) {
                view.ptyService.dispose();
            }
        }
    }

    async loadSettings() {
        this.settings = mergeSettings(await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // 首次安裝時 onload 會在建立 terminalManager 之前先儲存自動偵測的 shell
        if (!this.terminalManager) return;
        this.terminalManager.updateSettings(this.settings);
        this.registerQuickCommands();
        for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
            TerminalManager.terminalViewOf(leaf)?.refreshQuickCommandButtons();
        }
    }

    /**
     * 每個 quick command 註冊成一個 Obsidian 指令 (可從指令面板執行、可綁快捷鍵)。
     * 指令 id 使用 quick command 固定的 id，改名不會失去快捷鍵。
     * 設定頁打字時會反覆存檔：只有 id、顯示名稱或清單變動時才重新註冊 (指令內容在執行時才查設定)。
     */
    private registerQuickCommands() {
        const registrations = quickCommandRegistrations(this.settings.quickCommands);
        if (sameRegistrations(registrations, this.registeredQuickCommands)) return;

        for (const { id } of this.registeredQuickCommands) this.removeCommand(id);

        for (const { id, name, quickCommandId } of registrations) {
            this.addCommand({
                id,
                name,
                callback: () => { void this.terminalManager.runQuickCommand(quickCommandId); }
            });
        }
        this.registeredQuickCommands = registrations;
    }
}

