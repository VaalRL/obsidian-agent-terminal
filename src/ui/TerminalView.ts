import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, requireApiVersion, setIcon, setTooltip } from 'obsidian';
import { Terminal, IDisposable } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { PtyService } from '../services/PtyService';
import { AgentTerminalSettings, CwdMode, QuickCommand } from '../core/settings';
import { sendQuickCommand, QuickCommandResult, groupByProgram, isDangerousCommand, resolveDefaultQuickCommand } from '../core/QuickCommands';
import { PathResolver } from '../services/PathResolver';
import { ContextService } from '../services/ContextService';
import { RuntimeResolver, NO_RUNTIME_MESSAGE } from '../services/RuntimeResolver';
import { NativeInstaller } from '../services/NativeInstaller';
import { detectObsidianCli, currentCliHost, prependPath, MIN_CLI_VERSION } from '../services/ObsidianCli';
import { ConfirmModal } from './ConfirmModal';
import { attachClipboardShortcuts } from './ClipboardShortcuts';

export const TERMINAL_VIEW_TYPE = 'agent-terminal-view';

export class TerminalView extends ItemView {
    private terminal!: Terminal;
    private fitAddon!: FitAddon;
    public ptyService: PtyService | null = null;
    private settings: AgentTerminalSettings;
    private cwd: string;
    private cwdLabel!: HTMLElement;
    private resizeObserver: ResizeObserver | null = null;
    private resizeTimeout: number | null = null;
    private initTimeout: number | null = null;
    private initId = 0;
    private quickBtn: HTMLButtonElement | null = null;
    private quickMenuBtn: HTMLButtonElement | null = null;
    
    // 事件監聽器銷毀器
    private disposables: IDisposable[] = [];

    constructor(
        leaf: WorkspaceLeaf,
        settings: AgentTerminalSettings,
        cwd: string,
        private nativeInstaller: NativeInstaller | null = null
    ) {
        super(leaf);
        this.settings = settings;
        this.cwd = cwd;
    }

    getViewType(): string {
        return TERMINAL_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Terminal';
    }

    getIcon(): string {
        return 'terminal';
    }

    async onOpen() {
        if (this.initTimeout) window.clearTimeout(this.initTimeout);

        const { contentEl } = this;
        contentEl.empty();
        contentEl.classList.add('agent-terminal-container');

        // 建立內嵌式功能列
        const headerBar = contentEl.createDiv({ cls: 'agent-terminal-header' });
        
        // CWD 標籤
        this.cwdLabel = headerBar.createDiv({ 
            text: `📁 ${this.cwd}`, 
            cls: 'agent-terminal-cwd-label' 
        });

        // 按鈕群組
        const btnGroup = headerBar.createDiv({ cls: 'agent-terminal-btn-group' });

        // 0. Quick commands (一鍵送出 AI agent 等常用指令)：
        //    設定了預設指令時，🤖 直接送出預設、▾ 或右鍵打開完整選單；未設定時 🤖 打開選單
        this.quickBtn = btnGroup.createEl('button', { cls: 'agent-terminal-btn' });
        setIcon(this.quickBtn, 'bot');
        this.quickMenuBtn = btnGroup.createEl('button', {
            cls: 'agent-terminal-btn agent-terminal-btn-chevron',
            attr: { 'aria-label': 'More quick commands' }
        });
        setIcon(this.quickMenuBtn, 'chevron-down');
        this.registerDomEvent(this.quickBtn, 'click', (event) => {
            const defaultCommand = resolveDefaultQuickCommand(this.settings);
            if (defaultCommand) void this.runQuickCommand(defaultCommand);
            else this.showQuickCommandMenu(event);
        });
        this.registerDomEvent(this.quickBtn, 'contextmenu', (event) => {
            event.preventDefault();
            this.showQuickCommandMenu(event);
        });
        this.registerDomEvent(this.quickMenuBtn, 'click', (event) => this.showQuickCommandMenu(event));
        this.refreshQuickCommandButtons();

        // 1. 初始化按鈕
        const bootstrapBtn = btnGroup.createEl('button', { cls: 'agent-terminal-btn', attr: { 'aria-label': 'Bootstrap AI core' } });
        bootstrapBtn.ariaLabel = 'Bootstrap AI core';
        setIcon(bootstrapBtn, 'sparkles');
        this.registerDomEvent(bootstrapBtn, 'click', () => {
            void ContextService.performBootstrap(this.app, (request) => ConfirmModal.ask(this.app, request));
        });

        // 2. 定位按鈕
        const locateBtn = btnGroup.createEl('button', { cls: 'agent-terminal-btn', attr: { 'aria-label': 'Locate to current file' } });
        locateBtn.ariaLabel = 'Locate to current file';
        setIcon(locateBtn, 'folder-input');
        this.registerDomEvent(locateBtn, 'click', () => {
            const newCwd = PathResolver.resolveCwd(this.app, { ...this.settings, cwdMode: CwdMode.CurrentFile });
            this.restart(newCwd);
        });

        // 3. 重啟按鈕
        const restartBtn = btnGroup.createEl('button', { cls: 'agent-terminal-btn', attr: { 'aria-label': 'Restart terminal' } });
        restartBtn.ariaLabel = 'Restart terminal';
        setIcon(restartBtn, 'refresh-cw');
        this.registerDomEvent(restartBtn, 'click', () => this.restart());

        const terminalContainer = contentEl.createDiv({ cls: 'agent-terminal-content' });
        this.terminal = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Consolas, "Courier New", monospace',
            theme: {
                background: 'transparent' // 讓它跟隨 Obsidian 背景
            },
            allowProposedApi: true
        });

        // 鍵盤複製/貼上 (各平台快捷鍵見 ClipboardShortcuts)
        const platform = Platform.isMacOS ? 'mac' : Platform.isWin ? 'windows' : 'linux';
        attachClipboardShortcuts(this.terminal, platform, navigator.clipboard);

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        
        this.terminal.open(terminalContainer);
        
        // Debounced ResizeObserver for efficient resize handling
        this.resizeObserver = new ResizeObserver(() => {
            if (this.resizeTimeout) window.clearTimeout(this.resizeTimeout);
            this.resizeTimeout = window.setTimeout(() => this.safeFit(), 50);
        });
        this.resizeObserver.observe(terminalContainer);

        // 延遲一下確保 DOM 已經準備好再進行第一次 fit
        this.initTimeout = window.setTimeout(() => {
            this.safeFit();
            void this.initPty();
            this.initTimeout = null;
        }, 100);
    }

    private async initPty() {
        // 每次初始化取得新的序號；await 期間若又重啟或關閉了 view，舊的初始化就放棄，避免產生兩個 PTY
        const initId = ++this.initId;
        try {
            // 先清理舊的監聽器與 PTY
            this.destroyPty();
            this.cwdLabel.setText(`📁 ${this.cwd}`);

            let runtime = await RuntimeResolver.resolve();
            if (initId !== this.initId) return;
            if (!runtime) {
                this.writeLine(NO_RUNTIME_MESSAGE, 'error');
                return;
            }

            if (!(await this.ensureNativeEngine())) return;
            if (initId !== this.initId) return;

            // Obsidian 官方 CLI 已註冊但不在 PATH (macOS Dock 啟動、Windows 尚未重開 Obsidian…) 時，
            // 把它的資料夾加進終端機的 PATH，讓 AI agent 可以用 obsidian 指令控制 Obsidian
            const cli = detectObsidianCli(currentCliHost(requireApiVersion(MIN_CLI_VERSION)));
            if (cli.state === 'available' && !cli.onPath) {
                runtime = { ...runtime, env: prependPath(runtime.env, cli.dir, process.platform) };
            }

            this.ptyService = new PtyService(
                this.settings.shellPath,
                this.cwd,
                this.terminal.cols,
                this.terminal.rows,
                runtime
            );
            
            // 將底層輸出導入 UI
            this.ptyService.onData((data) => {
                this.terminal.write(data);
            });

            // 將 UI 輸入導入底層，並保存銷毀器
            this.disposables.push(this.terminal.onData((data) => {
                this.ptyService?.write(data);
            }));

            // 綁定 resize 事件，並保存銷毀器
            this.disposables.push(this.terminal.onResize(({ cols, rows }) => {
                this.ptyService?.resize(cols, rows);
            }));

        } catch (error) {
            this.writeLine((error as Error).message, 'error');
        }
    }

    /** 依目前的預設指令更新 🤖 的說明文字與 ▾ 的顯示 (設定變更時由外掛呼叫) */
    public refreshQuickCommandButtons() {
        if (!this.quickBtn || !this.quickMenuBtn) return;
        const defaultCommand = resolveDefaultQuickCommand(this.settings);
        const label = defaultCommand
            ? `Run: ${defaultCommand.name || defaultCommand.command} (right-click for more)`
            : 'Quick commands';
        setTooltip(this.quickBtn, label);
        this.quickMenuBtn.toggleClass('agent-terminal-hidden', !defaultCommand);
    }

    private showQuickCommandMenu(event: MouseEvent) {
        const menu = new Menu();
        // 依程式 (claude、agy…) 分組，組與組之間以分隔線區隔
        const groups = groupByProgram(this.settings.quickCommands);
        if (groups.length === 0) {
            menu.addItem(item => item.setTitle('No quick commands. Add them in the plugin settings.').setDisabled(true));
        }
        groups.forEach((group, index) => {
            if (index > 0) menu.addSeparator();
            for (const quickCommand of group) {
                menu.addItem(item => item
                    .setTitle(quickCommand.name || quickCommand.command)
                    .setChecked(quickCommand.id === this.settings.defaultQuickCommandId)
                    // 跳過權限確認的指令以警示圖示標出，避免誤點
                    .setIcon(isDangerousCommand(quickCommand.command) ? 'shield-alert' : 'play')
                    .onClick(() => { void this.runQuickCommand(quickCommand); }));
            }
        });
        menu.showAtMouseEvent(event);
    }

    /**
     * 在這個終端機送出 quick command。終端機剛開啟或已結束時，先等 shell 就緒。
     */
    public async runQuickCommand(quickCommand: QuickCommand): Promise<QuickCommandResult> {
        const pty = await this.waitForPty();
        // 預設從 Vault 根目錄啟動 (agent 的「繼續上次」以啟動資料夾為範圍，指示檔也在根目錄)
        const vaultRoot = PathResolver.resolveCwd(this.app, { ...this.settings, cwdMode: CwdMode.VaultRoot });
        const cwd = this.settings.quickCommandsFromVaultRoot && this.cwd !== vaultRoot ? vaultRoot : undefined;
        const result = pty
            ? await sendQuickCommand(pty, this.settings.shellPath, quickCommand.command, { cwd })
            : 'unavailable';
        if (result === 'sent' && cwd) this.setCwd(cwd);

        if (result === 'busy') {
            new Notice(`A program is already running in the terminal. Exit it first, then run "${quickCommand.name || quickCommand.command}" again.`);
        } else if (result === 'unavailable') {
            new Notice('The terminal is not ready. Check the message in the terminal, then try again.');
        }
        this.terminal?.focus();
        return result;
    }

    /**
     * 把文字原樣送進終端機 (例如編輯器的「Run in terminal」)。終端機剛開啟或已結束時，先等 shell 就緒；
     * 回傳 false 表示等不到可用的 shell。
     */
    public async sendText(text: string): Promise<boolean> {
        const pty = await this.waitForPty();
        if (!pty) return false;
        pty.write(text);
        this.terminal?.focus();
        return true;
    }

    /** 等待 PTY 可用：已結束的 session 會先重啟；逾時 (例如使用者還沒回覆下載確認) 回傳 null */
    private async waitForPty(timeoutMs = 30000): Promise<PtyService | null> {
        if (this.ptyService?.isTerminated) this.restart();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.ptyService && !this.ptyService.isTerminated) return this.ptyService;
            await new Promise(resolve => window.setTimeout(resolve, 100));
        }
        return null;
    }

    /**
     * 確保 node-pty 已安裝 (第一次使用時徵求同意後下載)。回傳 false 表示無法啟動終端機。
     */
    private async ensureNativeEngine(): Promise<boolean> {
        if (!this.nativeInstaller) return true;
        try {
            const result = await this.nativeInstaller.ensureInstalled((size) => this.askDownloadConsent(size));
            if (result === 'declined') {
                this.writeLine('The terminal engine was not downloaded. Click the restart button to be asked again.', 'warning');
                return false;
            }
            if (result === 'unsupported') {
                // 沒有此平台的預編譯檔：仍嘗試啟動 (使用者可能已手動安裝)，失敗時 bridge 會回報原因
                this.writeLine(`No prebuilt terminal engine is available for ${process.platform}-${process.arch}. See the README for manual installation.`, 'warning');
            }
            return true;
        } catch (error) {
            this.writeLine((error as Error).message, 'error');
            return false;
        }
    }

    private async askDownloadConsent(sizeBytes: number): Promise<boolean> {
        const confirmed = await ConfirmModal.ask(this.app, {
            title: 'Download terminal engine',
            message: `Agent Terminal needs its terminal engine (node-pty, about ${Math.ceil(sizeBytes / 1024)} KB) `
                + 'to run shells. It will be downloaded once from this plugin\'s GitHub releases and verified before installing.',
            confirmLabel: 'Download'
        });
        if (confirmed) this.writeLine('Downloading terminal engine…', 'info');
        return confirmed;
    }

    private writeLine(message: string, level: 'info' | 'warning' | 'error') {
        const color = { info: '36', warning: '33', error: '31' }[level];
        this.terminal.write(`\r\n\x1b[${color}m${message}\x1b[0m\r\n`);
    }

    async onClose() {
        // 讓進行中的 initPty 在 await 之後放棄
        this.initId++;
        if (this.initTimeout) {
            window.clearTimeout(this.initTimeout);
            this.initTimeout = null;
        }
        if (this.resizeTimeout) window.clearTimeout(this.resizeTimeout);
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.destroyPty();
        if (this.terminal) {
            this.terminal.dispose();
        }
    }

    onResize() {
        super.onResize();
        this.safeFit();
    }

    private safeFit() {
        if (!this.fitAddon) return;
        try {
            this.fitAddon.fit();
        } catch {
            // 在極限縮放或視窗隱藏時，xterm 的 fit() 可能會失敗，攔截該錯誤以確保穩定性
        }
    }

    private destroyPty() {
        // 銷毀所有終端機事件監聽器
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];

        if (this.ptyService) {
            this.ptyService.dispose();
            this.ptyService = null;
        }
    }

    public get currentCwd(): string {
        return this.cwd;
    }

    /**
     * 記錄 shell 已切換到的目錄並更新位置標籤 (不重啟終端機)
     */
    public setCwd(dir: string) {
        this.cwd = dir;
        if (this.cwdLabel) this.cwdLabel.setText(`📁 ${dir}`);
    }

    /**
     * 重啟終端機
     */
    public restart(newCwd?: string) {
        if (newCwd) {
            this.cwd = newCwd;
        }
        this.terminal.clear();
        void this.initPty();
    }
}
