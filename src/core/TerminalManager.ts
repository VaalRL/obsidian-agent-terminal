import { App, WorkspaceLeaf } from 'obsidian';
import { AgentTerminalSettings, CwdMode } from './settings';
import { resolveDefaultQuickCommand, QuickCommandResult } from './QuickCommands';
import { PathResolver } from '../services/PathResolver';
import { EnvironmentService } from '../services/EnvironmentService';
import { TerminalView, TERMINAL_VIEW_TYPE } from '../ui/TerminalView';

export class TerminalManager {
    private app: App;
    private settings: AgentTerminalSettings;
    private latestSyncId = 0;

    constructor(app: App, settings: AgentTerminalSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: AgentTerminalSettings): void {
        this.settings = settings;
    }

    async activateTerminalView(): Promise<WorkspaceLeaf> {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null;
        const leaves = workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);

        if (leaves.length > 0) {
            // 如果已經開啟，聚焦到該視窗
            leaf = leaves[0];
        } else {
            // 否則在右側新建一個面板
            leaf = workspace.getRightLeaf(false);
            if (!leaf) {
                 leaf = workspace.getLeaf(true); // fallback
            }
            const cwd = PathResolver.resolveCwd(this.app, this.settings);
            
            // 設定 View 的內部狀態
            await leaf.setViewState({
                type: TERMINAL_VIEW_TYPE,
                active: true,
                state: { cwd }
            });
        }

        // Obsidian 1.7.2 起，背景分頁 (例如重開 Obsidian 後還原的終端機) 是延遲載入的：
        // leaf.view 在載入前是 DeferredView。revealLeaf 回傳 Promise，await 後 view 才會載入完成。
        await workspace.revealLeaf(leaf);
        // 保險起見再要求載入一次 (測試替身等沒有 loadIfDeferred 的 leaf 則略過)
        if (typeof leaf.loadIfDeferred === 'function') await leaf.loadIfDeferred();
        return leaf;
    }

    /** 取得 leaf 上已載入的 TerminalView；仍是延遲載入的 DeferredView 或其他 view 時回傳 null */
    static terminalViewOf(leaf: WorkspaceLeaf): TerminalView | null {
        return leaf.view instanceof TerminalView ? leaf.view : null;
    }

    /**
     * 執行 quick command (由 Obsidian 指令 / 快捷鍵呼叫)：開啟終端機後交給 TerminalView 送出。
     * 每次執行時才依 id 查設定，設定頁修改內容後不必重新註冊指令。
     */
    async runQuickCommand(id: string): Promise<QuickCommandResult> {
        const quickCommand = this.settings.quickCommands.find(q => q.id === id);
        if (!quickCommand) return 'unavailable';

        const view = TerminalManager.terminalViewOf(await this.activateTerminalView());
        return view ? view.runQuickCommand(quickCommand) : 'unavailable';
    }

    /**
     * 開啟終端機並送出一行文字 (編輯器右鍵「Run in terminal」)。
     * 交給 TerminalView.sendText 等 shell 就緒，避免終端機剛開啟時 ptyService 尚未建立而丟掉文字。
     */
    async runInTerminal(text: string): Promise<'sent' | 'unavailable'> {
        const view = TerminalManager.terminalViewOf(await this.activateTerminalView());
        if (!view) return 'unavailable';
        return (await view.sendText(text + '\r')) ? 'sent' : 'unavailable';
    }

    /** 執行按鈕的預設 quick command (Obsidian 指令「Run default quick command」) */
    runDefaultQuickCommand(): Promise<QuickCommandResult> {
        const quickCommand = resolveDefaultQuickCommand(this.settings);
        return quickCommand ? this.runQuickCommand(quickCommand.id) : Promise.resolve('no-default');
    }

    /**
     * 當 Auto-Sync 開啟且使用者切換筆記時，此方法會被觸發。
     */
    async syncCwd(): Promise<void> {
        if (!this.settings.autoSyncCwd) return;
        const syncId = ++this.latestSyncId;

        // Auto-Sync 永遠跟隨目前筆記所在資料夾，與「預設啟動目錄」設定無關
        const targetPath = PathResolver.resolveCwd(this.app, { ...this.settings, cwdMode: CwdMode.CurrentFile });

        // 找到所有已開啟、且不在目標目錄的 TerminalView (同一資料夾內切換筆記時不重複 cd)
        const views = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)
            .map(leaf => TerminalManager.terminalViewOf(leaf))
            .filter((view): view is TerminalView => view !== null && view.ptyService !== null && !view.ptyService.isTerminated && view.currentCwd !== targetPath);

        const foregrounds = await Promise.all(views.map(view => view.ptyService!.getForegroundProcess()));

        // 等待期間使用者又切換了筆記，交給較新的請求處理
        if (syncId !== this.latestSyncId) return;

        views.forEach((view, i) => {
            const pty = view.ptyService;
            if (!pty || pty.isTerminated) return;
            // 只有 shell 本身在前景 (等待指令) 時才送 cd，避免把指令打進 AI CLI、vim 等互動程式；
            // 無法判斷 (Windows) 時也不送
            if (!EnvironmentService.isShellProcess(this.settings.shellPath, foregrounds[i])) return;

            pty.write(EnvironmentService.buildCdCommand(this.settings.shellPath, targetPath));
            view.setCwd(targetPath);
        });
    }
}

