import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
// 由 vitest.config.ts 的 alias 導向 tests/__mocks__/obsidian.ts
import { FileSystemAdapter } from 'obsidian';

// TerminalView 依賴 xterm (需要瀏覽器 DOM)，這裡只需要它的 view type 常數
// TerminalView 是空殼類別：測試用的 view 以它的 prototype 建立，才能通過 instanceof 檢查
vi.mock('../src/ui/TerminalView', () => ({
    TERMINAL_VIEW_TYPE: 'agent-terminal-view',
    TerminalView: class {}
}));

import { TerminalManager } from '../src/core/TerminalManager';
import { TerminalView } from '../src/ui/TerminalView';

/** 建立通過 instanceof TerminalView 的假 view */
function asTerminalView<T extends object>(fields: T): T {
    return Object.assign(Object.create(TerminalView.prototype), fields);
}
import { CwdMode, AgentTerminalSettings, DEFAULT_SETTINGS } from '../src/core/settings';

const VAULT = '/mock/vault';

function makeView(cwd: string, { terminated = false, foreground = 'bash' as string | null } = {}) {
    const view = asTerminalView({
        currentCwd: cwd,
        ptyService: {
            isTerminated: terminated,
            write: vi.fn(),
            getForegroundProcess: vi.fn(async () => foreground)
        },
        setCwd: vi.fn((dir: string) => { view.currentCwd = dir; })
    });
    return view;
}

describe('TerminalManager.syncCwd', () => {
    let app: any;
    let views: ReturnType<typeof makeView>[];

    const settings = (overrides: Partial<AgentTerminalSettings> = {}): AgentTerminalSettings => ({
        ...DEFAULT_SETTINGS,
        shellPath: '/bin/bash',
        autoSyncCwd: true,
        ...overrides
    });

    const openNote = (folder: string) => {
        app.workspace.getActiveFile.mockReturnValue({ parent: { path: folder } });
    };

    beforeEach(() => {
        views = [makeView(VAULT)];
        app = {
            vault: { adapter: new (FileSystemAdapter as any)(VAULT) },
            workspace: {
                getActiveFile: vi.fn(),
                getLeavesOfType: vi.fn(() => views.map(view => ({ view })))
            }
        };
    });

    it('should follow the current note folder even when the startup mode is Vault Root', async () => {
        const manager = new TerminalManager(app, settings({ cwdMode: CwdMode.VaultRoot }));
        openNote('Projects/Alpha');

        await manager.syncCwd();

        const target = path.join(VAULT, 'Projects/Alpha');
        expect(views[0].ptyService.write).toHaveBeenCalledWith(`cd '${target}'\r`);
        expect(views[0].setCwd).toHaveBeenCalledWith(target);
    });

    it('should follow the current note folder even when the startup mode is Custom Path', async () => {
        const manager = new TerminalManager(app, settings({ cwdMode: CwdMode.CustomPath, customCwdPath: '/somewhere/else' }));
        openNote('Daily');

        await manager.syncCwd();

        expect(views[0].ptyService.write).toHaveBeenCalledWith(`cd '${path.join(VAULT, 'Daily')}'\r`);
    });

    it('should do nothing when Auto-Sync is off', async () => {
        const manager = new TerminalManager(app, settings({ autoSyncCwd: false }));
        openNote('Projects/Alpha');

        await manager.syncCwd();

        expect(views[0].ptyService.write).not.toHaveBeenCalled();
    });

    it('should not send cd again when switching between notes in the same folder', async () => {
        const manager = new TerminalManager(app, settings());
        openNote('Projects/Alpha');

        await manager.syncCwd();
        await manager.syncCwd();

        expect(views[0].ptyService.write).toHaveBeenCalledTimes(1);
    });

    it('should skip leaves that are not loaded terminal views (deferred tabs)', async () => {
        const deferred = { view: { ptyService: { isTerminated: false, write: vi.fn(), getForegroundProcess: vi.fn(async () => 'bash') } } };
        app.workspace.getLeavesOfType.mockReturnValue([deferred, ...views.map(view => ({ view }))]);
        const manager = new TerminalManager(app, settings());
        openNote('Projects/Alpha');

        await manager.syncCwd();

        expect(deferred.view.ptyService.write).not.toHaveBeenCalled();
        expect(views[0].ptyService.write).toHaveBeenCalledTimes(1);
    });

    it('should skip terminals whose session has ended', async () => {
        views = [makeView(VAULT, { terminated: true })];
        const manager = new TerminalManager(app, settings());
        openNote('Projects/Alpha');

        await manager.syncCwd();

        expect(views[0].ptyService.write).not.toHaveBeenCalled();
        expect(views[0].setCwd).not.toHaveBeenCalled();
    });

    it('should use the shell-specific cd command (cmd.exe)', async () => {
        views = [makeView(VAULT, { foreground: 'cmd.exe' })];
        const manager = new TerminalManager(app, settings({ shellPath: 'C:\\Windows\\System32\\cmd.exe' }));
        openNote('Notes');

        await manager.syncCwd();

        expect(views[0].ptyService.write).toHaveBeenCalledWith(`cd /d "${path.join(VAULT, 'Notes')}"\r`);
    });

    describe('when a program is running in the foreground', () => {
        it.each(['claude', 'gemini', 'vim', 'node'])('should not type cd into %s', async (program) => {
            views = [makeView(VAULT, { foreground: program })];
            const manager = new TerminalManager(app, settings());
            openNote('Projects/Alpha');

            await manager.syncCwd();

            expect(views[0].ptyService.write).not.toHaveBeenCalled();
            expect(views[0].setCwd).not.toHaveBeenCalled();
        });

        it('should not send cd when the foreground process is unknown (Windows)', async () => {
            views = [makeView(VAULT, { foreground: null })];
            const manager = new TerminalManager(app, settings());
            openNote('Projects/Alpha');

            await manager.syncCwd();

            expect(views[0].ptyService.write).not.toHaveBeenCalled();
        });

        it('should only sync terminals whose shell is idle', async () => {
            views = [makeView(VAULT, { foreground: 'claude' }), makeView(VAULT, { foreground: 'bash' })];
            const manager = new TerminalManager(app, settings());
            openNote('Projects/Alpha');

            await manager.syncCwd();

            expect(views[0].ptyService.write).not.toHaveBeenCalled();
            expect(views[1].ptyService.write).toHaveBeenCalledTimes(1);
        });
    });

    it('should only apply the latest request when notes are switched quickly', async () => {
        let releaseFirst!: (name: string) => void;
        views[0].ptyService.getForegroundProcess
            .mockImplementationOnce(() => new Promise<string>(resolve => { releaseFirst = resolve; }));
        const manager = new TerminalManager(app, settings());

        openNote('First');
        const first = manager.syncCwd();
        openNote('Second');
        await manager.syncCwd();
        releaseFirst('bash');
        await first;

        expect(views[0].ptyService.write).toHaveBeenCalledTimes(1);
        expect(views[0].ptyService.write).toHaveBeenCalledWith(`cd '${path.join(VAULT, 'Second')}'\r`);
        expect(views[0].currentCwd).toBe(path.join(VAULT, 'Second'));
    });
});

describe('TerminalManager.runQuickCommand', () => {
    function setup(quickCommands = DEFAULT_SETTINGS.quickCommands) {
        const view = asTerminalView({ runQuickCommand: vi.fn(async () => 'sent') });
        const app: any = {
            vault: { adapter: new (FileSystemAdapter as any)(VAULT) },
            workspace: {
                getActiveFile: vi.fn(),
                getLeavesOfType: vi.fn(() => [{ view }]),
                revealLeaf: vi.fn()
            }
        };
        const manager = new TerminalManager(app, { ...DEFAULT_SETTINGS, quickCommands });
        return { manager, view, app };
    }

    it('should open the terminal and run the quick command with the given id there', async () => {
        const { manager, view, app } = setup();

        await expect(manager.runQuickCommand('agy')).resolves.toBe('sent');

        expect(app.workspace.revealLeaf).toHaveBeenCalled();
        expect(view.runQuickCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'agy' }));
    });

    it('should look the command up at run time so edits take effect without re-registering', async () => {
        const commands = [{ id: 'mine', name: 'Mine', command: 'claude' }];
        const { manager, view } = setup(commands);
        commands[0].command = 'claude --continue';

        await manager.runQuickCommand('mine');

        expect(view.runQuickCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude --continue' }));
    });

    it('should wait for revealLeaf so a deferred tab (Obsidian 1.7.2+) is loaded first', async () => {
        const { manager, view, app } = setup();
        // 延遲載入的分頁：revealLeaf 完成前 leaf.view 是 DeferredView，完成後才換成 TerminalView
        const leaf: { view: unknown } = { view: { deferred: true } };
        app.workspace.getLeavesOfType.mockReturnValue([leaf]);
        app.workspace.revealLeaf.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            leaf.view = view;
        });

        await expect(manager.runQuickCommand('agy')).resolves.toBe('sent');
        expect(view.runQuickCommand).toHaveBeenCalled();
    });

    it('should report unavailable instead of throwing when the leaf is not a terminal view', async () => {
        const { manager, app } = setup();
        app.workspace.getLeavesOfType.mockReturnValue([{ view: { deferred: true } }]);

        await expect(manager.runQuickCommand('agy')).resolves.toBe('unavailable');
    });

    it('should load a deferred leaf when loadIfDeferred is available', async () => {
        const { manager, view, app } = setup();
        const leaf: { view: unknown; loadIfDeferred: () => Promise<void> } = {
            view: { deferred: true },
            loadIfDeferred: vi.fn(async () => { leaf.view = view; })
        };
        app.workspace.getLeavesOfType.mockReturnValue([leaf]);

        await expect(manager.runQuickCommand('agy')).resolves.toBe('sent');
        expect(leaf.loadIfDeferred).toHaveBeenCalled();
    });

    it('should do nothing for a quick command that no longer exists', async () => {
        const { manager, view } = setup();

        await expect(manager.runQuickCommand('deleted')).resolves.toBe('unavailable');
        expect(view.runQuickCommand).not.toHaveBeenCalled();
    });
});

describe('TerminalManager.runDefaultQuickCommand', () => {
    function setup(defaultQuickCommandId: string) {
        const view = asTerminalView({ runQuickCommand: vi.fn(async () => 'sent') });
        const app: any = {
            vault: { adapter: new (FileSystemAdapter as any)(VAULT) },
            workspace: { getActiveFile: vi.fn(), getLeavesOfType: vi.fn(() => [{ view }]), revealLeaf: vi.fn() }
        };
        const manager = new TerminalManager(app, { ...DEFAULT_SETTINGS, defaultQuickCommandId });
        return { manager, view };
    }

    it('should run the default quick command', async () => {
        const { manager, view } = setup('agy-continue');

        await expect(manager.runDefaultQuickCommand()).resolves.toBe('sent');
        expect(view.runQuickCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'agy --continue' }));
    });

    it('should report when no default is chosen', async () => {
        const { manager, view } = setup('');

        await expect(manager.runDefaultQuickCommand()).resolves.toBe('no-default');
        expect(view.runQuickCommand).not.toHaveBeenCalled();
    });
});

describe('TerminalManager.runInTerminal', () => {
    function setup(view: object) {
        const app: any = {
            vault: { adapter: new (FileSystemAdapter as any)(VAULT) },
            workspace: { getActiveFile: vi.fn(), getLeavesOfType: vi.fn(() => [{ view }]), revealLeaf: vi.fn() }
        };
        return new TerminalManager(app, { ...DEFAULT_SETTINGS });
    }

    it('should hand the text to the view, which waits for a shell that is still starting', async () => {
        // 終端機剛開啟：ptyService 還沒建立 (TerminalView 延遲 100ms 才 initPty)，sendText 會等它就緒
        const view = asTerminalView({ ptyService: null, sendText: vi.fn(async () => true) });
        const manager = setup(view);

        await expect(manager.runInTerminal('ls -la')).resolves.toBe('sent');
        expect(view.sendText).toHaveBeenCalledWith('ls -la\r');
    });

    it('should report unavailable when the shell never became ready', async () => {
        const view = asTerminalView({ ptyService: null, sendText: vi.fn(async () => false) });

        await expect(setup(view).runInTerminal('ls')).resolves.toBe('unavailable');
    });

    it('should report unavailable when the leaf is not a terminal view', async () => {
        await expect(setup({ deferred: true }).runInTerminal('ls')).resolves.toBe('unavailable');
    });
});
