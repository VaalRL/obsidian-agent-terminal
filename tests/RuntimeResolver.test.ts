import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// 探測 runtime 時會啟動子進程，測試時攔截 spawn
vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'child_process';
import { RuntimeResolver, RuntimeHost } from '../src/services/RuntimeResolver';

class FakeProbe extends EventEmitter {
    stdout = new EventEmitter();
    kill = vi.fn();
}

type ProbeBehavior = 'ok' | 'late-output' | 'exit' | 'error' | 'hang';

const OBSIDIAN_EXE = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';

function host(isElectron: boolean): RuntimeHost {
    return {
        versions: isElectron ? { electron: '37.0.0', node: '22.0.0' } : { node: '22.0.0' },
        execPath: isElectron ? OBSIDIAN_EXE : '/usr/bin/node',
        env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' }
    };
}

describe('RuntimeResolver', () => {
    let behaviors: Record<string, ProbeBehavior>;
    let probes: FakeProbe[];

    beforeEach(() => {
        RuntimeResolver.clearCache();
        probes = [];
        behaviors = {};
        vi.mocked(spawn).mockReset();
        vi.mocked(spawn).mockImplementation(((command: string, args: string[]) => {
            const probe = new FakeProbe();
            probes.push(probe);
            setImmediate(() => {
                switch (behaviors[command] ?? 'exit') {
                    case 'ok':
                        // 探測程式印出 -e 腳本要求的標記
                        probe.stdout.emit('data', Buffer.from(String(args[1]).match(/__\w+__/)![0]));
                        probe.emit('exit', 0);
                        probe.emit('close', 0);
                        break;
                    case 'late-output':
                        // 'exit' 早於 stdout 的資料 (實際會發生)：資料在 stdio 關閉 ('close') 前才到
                        probe.emit('exit', 0);
                        probe.stdout.emit('data', Buffer.from(String(args[1]).match(/__\w+__/)![0]));
                        probe.emit('close', 0);
                        break;
                    case 'exit':
                        probe.emit('exit', 0);
                        probe.emit('close', 0);
                        break;
                    case 'error':
                        probe.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
                        break;
                    case 'hang':
                        break;
                }
            });
            return probe;
        }) as any);
    });

    it('should accept a runtime whose marker arrives after the exit event', async () => {
        behaviors[OBSIDIAN_EXE] = 'late-output';

        const runtime = await RuntimeResolver.resolve(host(true));

        expect(runtime?.kind).toBe('electron');
    });

    // 多個終端機同時開啟時 (例如重開 Obsidian 還原多個分頁)，只探測一次
    it('should share one probe between concurrent calls', async () => {
        behaviors[OBSIDIAN_EXE] = 'ok';

        const [first, second] = await Promise.all([RuntimeResolver.resolve(host(true)), RuntimeResolver.resolve(host(true))]);

        expect(first?.kind).toBe('electron');
        expect(second).toBe(first);
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("should prefer Obsidian's built-in Electron running as Node", async () => {
        behaviors[OBSIDIAN_EXE] = 'ok';
        behaviors['node'] = 'ok';

        const runtime = await RuntimeResolver.resolve(host(true));

        expect(runtime).toMatchObject({ kind: 'electron', command: OBSIDIAN_EXE });
        expect(runtime?.env.ELECTRON_RUN_AS_NODE).toBe('1');
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledWith(OBSIDIAN_EXE, ['-e', expect.any(String)],
            expect.objectContaining({ env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }) }));
    });

    it('should fall back to system node when Electron exits without answering (fuse disabled)', async () => {
        behaviors[OBSIDIAN_EXE] = 'exit';
        behaviors['node'] = 'ok';

        const runtime = await RuntimeResolver.resolve(host(true));

        expect(runtime).toMatchObject({ kind: 'node', command: 'node' });
    });

    it('should fall back to system node when Electron cannot be spawned', async () => {
        behaviors[OBSIDIAN_EXE] = 'error';
        behaviors['node'] = 'ok';

        await expect(RuntimeResolver.resolve(host(true))).resolves.toMatchObject({ kind: 'node' });
    });

    it('should give up on a probe that hangs and kill it', async () => {
        behaviors[OBSIDIAN_EXE] = 'hang';
        behaviors['node'] = 'ok';

        const runtime = await RuntimeResolver.resolve(host(true), 20);

        expect(runtime).toMatchObject({ kind: 'node' });
        expect(probes[0].kill).toHaveBeenCalled();
    });

    it('should not pass ELECTRON_RUN_AS_NODE to the system node runtime', async () => {
        behaviors['node'] = 'ok';

        const runtime = await RuntimeResolver.resolve(host(true));

        expect(runtime?.kind).toBe('node');
        expect(runtime?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(runtime?.env.PATH).toBe('/usr/bin');
    });

    it('should only try system node outside Electron', async () => {
        behaviors['node'] = 'ok';

        await expect(RuntimeResolver.resolve(host(false))).resolves.toMatchObject({ kind: 'node' });
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledWith('node', expect.anything(), expect.anything());
    });

    it('should return null when no runtime works, and probe again next time', async () => {
        await expect(RuntimeResolver.resolve(host(true))).resolves.toBeNull();
        expect(spawn).toHaveBeenCalledTimes(2);

        // 使用者安裝 Node.js 後重啟終端機，應重新探測
        behaviors['node'] = 'ok';
        await expect(RuntimeResolver.resolve(host(true))).resolves.toMatchObject({ kind: 'node' });
    });

    describe('Electron utility process', () => {
        const utility = { start: vi.fn() };

        // 多數 Obsidian 版本關閉了 RunAsNode fuse；utilityProcess 不受影響，也不需要安裝 Node.js
        it('should prefer a utility process without probing any executable', async () => {
            behaviors[OBSIDIAN_EXE] = 'ok';
            behaviors['node'] = 'ok';

            const runtime = await RuntimeResolver.resolve({ ...host(true), utility });

            expect(runtime).toMatchObject({ kind: 'utility', host: utility });
            expect(spawn).not.toHaveBeenCalled();
        });

        it('should not pass ELECTRON_RUN_AS_NODE to the utility process', async () => {
            const runtime = await RuntimeResolver.resolve({ ...host(true), utility });

            expect(runtime?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
            expect(runtime?.env.PATH).toBe('/usr/bin');
        });

        it('should fall back to probing when no utility process is available', async () => {
            behaviors['node'] = 'ok';

            const runtime = await RuntimeResolver.resolve({ ...host(true), utility: null });

            expect(runtime?.kind).toBe('node');
        });
    });

    it('should cache a working runtime', async () => {
        behaviors[OBSIDIAN_EXE] = 'ok';

        await RuntimeResolver.resolve(host(true));
        await RuntimeResolver.resolve(host(true));

        expect(spawn).toHaveBeenCalledTimes(1);
    });
});
