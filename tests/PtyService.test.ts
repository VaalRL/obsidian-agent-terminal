import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// PtyService 透過 child_process 啟動外部 bridge.js，測試時攔截 spawn，不實際啟動 Node 進程
vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'child_process';

type PtyServiceModule = typeof import('../src/services/PtyService');
type UtilityHost = import('../src/services/UtilityProcessHost').UtilityHost;

class MockStdin extends EventEmitter {
    write = vi.fn();
}

function spawnError(code: string, message = `spawn node ${code}`): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
}

class MockChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = new MockStdin();
    connected = true;
    send = vi.fn();
    kill = vi.fn();
}

describe('PtyService (bridge architecture)', () => {
    let pluginDir: string;
    let bridgePath: string;
    let child: MockChildProcess;
    let PtyService: PtyServiceModule['PtyService'];

    beforeEach(async () => {
        // bridgePath 是 static 狀態，每個測試重新載入模組以隔離
        vi.resetModules();
        vi.mocked(spawn).mockReset();
        ({ PtyService } = await import('../src/services/PtyService'));

        pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-'));
        bridgePath = path.join(pluginDir, 'bridge.js');
        fs.writeFileSync(bridgePath, '// bridge stub');

        child = new MockChildProcess();
        vi.mocked(spawn).mockReturnValue(child as any);
    });

    afterEach(() => {
        fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    it('should throw a readable error when bridge.js was never initialized', () => {
        expect(() => new PtyService('/bin/sh', '/mock/cwd')).toThrow(/bridge\.js/);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('should not register a bridge path when bridge.js is missing', () => {
        PtyService.initBridge(path.join(pluginDir, 'does-not-exist'));

        expect(() => new PtyService('/bin/sh', '/mock/cwd')).toThrow(/bridge\.js/);
    });

    describe('initBridge with embedded source', () => {
        let emptyDir: string;

        beforeEach(() => {
            emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-empty-'));
        });

        afterEach(() => {
            fs.rmSync(emptyDir, { recursive: true, force: true });
        });

        it('should write bridge.js into the plugin folder and use it', () => {
            PtyService.initBridge(emptyDir, '// bridge v1');

            expect(fs.readFileSync(path.join(emptyDir, 'bridge.js'), 'utf8')).toBe('// bridge v1');
            new PtyService('/bin/sh', '/mock/cwd');
            expect(spawn).toHaveBeenCalledWith('node', expect.arrayContaining([path.join(emptyDir, 'bridge.js')]), expect.anything());
        });

        it('should replace an outdated bridge.js after a plugin update', () => {
            fs.writeFileSync(path.join(emptyDir, 'bridge.js'), '// bridge v1');

            PtyService.initBridge(emptyDir, '// bridge v2');

            expect(fs.readFileSync(path.join(emptyDir, 'bridge.js'), 'utf8')).toBe('// bridge v2');
        });

        it('should not rewrite bridge.js when it is already up to date', () => {
            const file = path.join(emptyDir, 'bridge.js');
            fs.writeFileSync(file, '// same');
            const past = new Date('2020-01-01');
            fs.utimesSync(file, past, past);

            PtyService.initBridge(emptyDir, '// same');

            expect(fs.statSync(file).mtime.getTime()).toBe(past.getTime());
        });

        it('should leave the bridge unset (readable error later) when bridge.js cannot be written', () => {
            PtyService.initBridge(path.join(emptyDir, 'missing-dir'), '// bridge');

            expect(() => new PtyService('/bin/sh', '/mock/cwd')).toThrow(/bridge\.js/);
        });
    });

    it('should spawn bridge.js with shell, cwd and terminal size', () => {
        PtyService.initBridge(pluginDir);

        const service = new PtyService('/bin/sh', '/mock/cwd', 120, 40);

        expect(spawn).toHaveBeenCalledWith(
            'node',
            [bridgePath, '/bin/sh', '/mock/cwd', '120', '40'],
            expect.objectContaining({
                cwd: pluginDir,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                env: expect.objectContaining({
                    NODE_PATH: path.join(pluginDir, 'node_modules')
                })
            })
        );
        expect(service.isTerminated).toBe(false);
    });

    it("should spawn the bridge with the given runtime (Obsidian's Electron as Node)", () => {
        PtyService.initBridge(pluginDir);
        const runtime = {
            kind: 'electron' as const,
            command: '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
            env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' }
        };

        new PtyService('/bin/sh', '/mock/cwd', 80, 24, runtime);

        expect(spawn).toHaveBeenCalledWith(
            runtime.command,
            [bridgePath, '/bin/sh', '/mock/cwd', '80', '24'],
            expect.objectContaining({
                env: {
                    PATH: '/usr/bin',
                    ELECTRON_RUN_AS_NODE: '1',
                    NODE_PATH: path.join(pluginDir, 'node_modules')
                }
            })
        );
    });

    it('should hand the user\'s original NODE_PATH to the bridge so the shell gets it back', () => {
        PtyService.initBridge(pluginDir);

        new PtyService('/bin/sh', '/mock/cwd', 80, 24, { kind: 'node', command: 'node', env: { NODE_PATH: '/home/me/lib/node' } });

        expect(vi.mocked(spawn).mock.calls[0][2]?.env).toMatchObject({
            NODE_PATH: path.join(pluginDir, 'node_modules'),
            AGENT_TERMINAL_ORIGINAL_NODE_PATH: '/home/me/lib/node'
        });
    });

    it('should not invent an original NODE_PATH when the user had none', () => {
        PtyService.initBridge(pluginDir);

        new PtyService('/bin/sh', '/mock/cwd', 80, 24, { kind: 'node', command: 'node', env: {} });

        expect(vi.mocked(spawn).mock.calls[0][2]?.env).not.toHaveProperty('AGENT_TERMINAL_ORIGINAL_NODE_PATH');
    });

    it('should wrap synchronous spawn failures into a readable error', () => {
        PtyService.initBridge(pluginDir);
        vi.mocked(spawn).mockImplementationOnce(() => {
            throw new Error('EACCES');
        });

        expect(() => new PtyService('/bin/sh', '/mock/cwd')).toThrow(/Failed to start bridge process.*EACCES/s);
    });

    it('should forward bridge stdout to the onData callback', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');
        const onData = vi.fn();
        service.onData(onData);

        child.stdout.emit('data', Buffer.from('hello'));

        expect(onData).toHaveBeenCalledWith('hello');
    });

    it('should decode a multi-byte character split across two stdout chunks', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');
        const onData = vi.fn();
        service.onData(onData);
        // 「中」與方框字元「─」各 3 bytes，切在字元中間送出
        const bytes = Buffer.from('中─', 'utf8');

        child.stdout.emit('data', bytes.subarray(0, 1));
        child.stdout.emit('data', bytes.subarray(1, 4));
        child.stdout.emit('data', bytes.subarray(4));

        expect(onData.mock.calls.map(call => call[0]).join('')).toBe('中─');
        expect(onData).not.toHaveBeenCalledWith('');
    });

    it('should write input to bridge stdin', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');

        service.write('ls\r');

        expect(child.stdin.write).toHaveBeenCalledWith('ls\r');
    });

    it('should send resize via IPC and clamp to at least 1x1', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');

        service.resize(0, -5);
        expect(child.send).toHaveBeenCalledWith({ type: 'resize', cols: 1, rows: 1 });

        service.resize(100, 40);
        expect(child.send).toHaveBeenCalledWith({ type: 'resize', cols: 100, rows: 40 });
    });

    it('should skip resize when the IPC channel is disconnected', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');
        child.connected = false;

        service.resize(100, 40);

        expect(child.send).not.toHaveBeenCalled();
    });

    it('dispose should kill the bridge and ignore further write/resize', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');

        service.dispose();

        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(service.isTerminated).toBe(true);

        service.write('test');
        service.resize(100, 40);
        service.dispose();
        expect(child.stdin.write).not.toHaveBeenCalled();
        expect(child.send).not.toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it('should mark as terminated and notify the UI when the bridge exits', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');
        const onData = vi.fn();
        service.onData(onData);

        child.emit('close', 1, null);

        expect(service.isTerminated).toBe(true);
        expect(onData).toHaveBeenCalledWith(expect.stringContaining('Exit Code: 1'));
    });

    // 'exit' 可能早於 stdout 最後的資料；要等 stdio 都關閉 ('close') 才算結束
    it('should keep output that arrives after the bridge exited but before its stdio closed', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');
        const onData = vi.fn();
        service.onData(onData);

        child.emit('exit', 0, null);
        child.stdout.emit('data', Buffer.from('last words'));
        child.emit('close', 0, null);

        expect(onData.mock.calls.map(call => call[0])).toEqual([
            'last words',
            expect.stringContaining('Exit Code: 0')
        ]);
        expect(service.isTerminated).toBe(true);
    });

    it('should drop stdout data that arrives after dispose', () => {
        PtyService.initBridge(pluginDir);
        const service = new PtyService('/bin/sh', '/mock/cwd');
        const onData = vi.fn();
        service.onData(onData);

        service.dispose();
        child.stdout.emit('data', Buffer.from('late output'));

        expect(onData).not.toHaveBeenCalled();
    });

    describe('getForegroundProcess', () => {
        let service: InstanceType<PtyServiceModule['PtyService']>;

        beforeEach(() => {
            PtyService.initBridge(pluginDir);
            service = new PtyService('/bin/sh', '/mock/cwd');
        });

        const lastQueryId = () => {
            const msg = child.send.mock.calls.at(-1)?.[0];
            expect(msg).toMatchObject({ type: 'query-process' });
            return msg.id;
        };

        it('should query the bridge over IPC and resolve with the reported process name', async () => {
            const pending = service.getForegroundProcess();
            child.emit('message', { type: 'process', id: lastQueryId(), name: 'claude' });

            await expect(pending).resolves.toBe('claude');
        });

        it('should resolve null when the bridge cannot tell (Windows)', async () => {
            const pending = service.getForegroundProcess();
            child.emit('message', { type: 'process', id: lastQueryId(), name: null });

            await expect(pending).resolves.toBeNull();
        });

        it('should ignore replies for other queries', async () => {
            const first = service.getForegroundProcess();
            const firstId = lastQueryId();
            const second = service.getForegroundProcess();
            const secondId = lastQueryId();

            child.emit('message', { type: 'process', id: secondId, name: 'vim' });
            child.emit('message', { type: 'process', id: firstId, name: 'bash' });

            await expect(first).resolves.toBe('bash');
            await expect(second).resolves.toBe('vim');
        });

        // 沒有回覆 (undefined) 與 bridge 回報「無法判斷」(null，Windows) 是不同情況：前者不能當成 shell 閒置
        it('should resolve undefined when the bridge does not answer in time', async () => {
            await expect(service.getForegroundProcess(10)).resolves.toBeUndefined();
        });

        it('should resolve undefined without querying when the IPC channel is disconnected', async () => {
            child.connected = false;

            await expect(service.getForegroundProcess()).resolves.toBeUndefined();
            expect(child.send).not.toHaveBeenCalled();
        });

        it('should resolve pending queries with undefined when disposed', async () => {
            const pending = service.getForegroundProcess();
            service.dispose();

            await expect(pending).resolves.toBeUndefined();
        });
    });

    describe('error interception', () => {
        let service: InstanceType<PtyServiceModule['PtyService']>;
        let onData: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            PtyService.initBridge(pluginDir);
            service = new PtyService('/bin/sh', '/mock/cwd');
            onData = vi.fn();
            service.onData(onData);
        });

        it('should explain that Node.js is missing when spawn fails with ENOENT', () => {
            expect(() => child.emit('error', spawnError('ENOENT'))).not.toThrow();

            expect(service.isTerminated).toBe(true);
            expect(onData).toHaveBeenCalledWith(expect.stringContaining('Node.js'));
        });

        it.each(['EACCES', 'EPERM'])('should hint at antivirus blocking when spawn fails with %s', (code) => {
            child.emit('error', spawnError(code));

            expect(service.isTerminated).toBe(true);
            expect(onData).toHaveBeenCalledWith(expect.stringMatching(/antivirus/i));
        });

        it('should include the original message for unknown spawn errors', () => {
            child.emit('error', spawnError('EWHATEVER', 'something odd happened'));

            expect(onData).toHaveBeenCalledWith(expect.stringContaining('something odd happened'));
        });

        it('should not print a second "session closed" message after a spawn error', () => {
            child.emit('error', spawnError('ENOENT'));
            child.emit('close', -2, null);

            expect(onData).toHaveBeenCalledTimes(1);
        });

        it('should forward bridge "ERROR:" lines from stderr to the UI', () => {
            child.stderr.emit('data', Buffer.from('ERROR: Failed to start shell "/bad/shell": ENOENT\n'));

            expect(onData).toHaveBeenCalledWith(expect.stringContaining('Failed to start shell "/bad/shell": ENOENT'));
        });

        it('should decode a multi-byte "ERROR:" message split across stderr chunks', () => {
            const bytes = Buffer.from('ERROR: 找不到 shell\n', 'utf8');
            const cut = bytes.indexOf(Buffer.from('找', 'utf8')) + 1;

            child.stderr.emit('data', bytes.subarray(0, cut));
            child.stderr.emit('data', bytes.subarray(cut));

            expect(onData).toHaveBeenCalledTimes(1);
            expect(onData).toHaveBeenCalledWith(expect.stringContaining('找不到 shell'));
        });

        it('should keep other stderr output out of the terminal', () => {
            child.stderr.emit('data', Buffer.from('(node:123) ExperimentalWarning: something\n'));

            expect(onData).not.toHaveBeenCalled();
        });

        it('should survive stdin errors (EPIPE) and mark the session as terminated', () => {
            expect(() => child.stdin.emit('error', spawnError('EPIPE'))).not.toThrow();

            expect(service.isTerminated).toBe(true);
        });

        it('should not print "session closed" when the session was disposed on purpose (restart)', () => {
            service.dispose();
            child.emit('close', null, 'SIGTERM');

            expect(onData).not.toHaveBeenCalled();
        });
    });
});

// 渲染端的 MessagePort (DOM)：以 onmessage 收 { data }，utility process 結束時觸發 'close'
class FakeRendererPort {
    sent: unknown[] = [];
    closed = false;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    private closeListeners: (() => void)[] = [];
    postMessage(message: unknown) { this.sent.push(message); }
    close() { this.closed = true; }
    addEventListener(type: string, listener: () => void) {
        if (type === 'close') this.closeListeners.push(listener);
    }
    receive(data: unknown) { this.onmessage?.({ data }); }
    closeFromBridge() { this.closeListeners.forEach(listener => listener()); }
}

describe('PtyService (Electron utility process)', () => {
    let pluginDir: string;
    let PtyService: PtyServiceModule['PtyService'];
    let port: FakeRendererPort;
    let utilityChild: { kill: ReturnType<typeof vi.fn> };
    let connect: () => Promise<void>;
    let host: { start: Mock<unknown[], { child: typeof utilityChild; port: Promise<FakeRendererPort> }> };

    const runtime = () => ({ kind: 'utility' as const, host: host as unknown as UtilityHost, env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv });

    beforeEach(async () => {
        vi.resetModules();
        vi.mocked(spawn).mockReset();
        ({ PtyService } = await import('../src/services/PtyService'));
        pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-'));
        fs.writeFileSync(path.join(pluginDir, 'bridge.js'), '// bridge stub');
        PtyService.initBridge(pluginDir);

        port = new FakeRendererPort();
        utilityChild = { kill: vi.fn() };
        let resolvePort!: (port: FakeRendererPort) => void;
        const portPromise = new Promise<FakeRendererPort>((resolve) => { resolvePort = resolve; });
        host = { start: vi.fn(() => ({ child: utilityChild, port: portPromise })) };
        connect = async () => {
            resolvePort(port);
            await portPromise;
            await Promise.resolve();
        };
    });

    afterEach(() => {
        fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    it('should start bridge.js in a utility process with shell, cwd and size, without spawning node', () => {
        new PtyService('/bin/zsh', '/my vault', 120, 30, runtime());

        expect(spawn).not.toHaveBeenCalled();
        expect(host.start).toHaveBeenCalledWith(
            path.join(pluginDir, 'bridge.js'),
            ['/bin/zsh', '/my vault', '120', '30'],
            {
                cwd: pluginDir,
                env: expect.objectContaining({ PATH: '/usr/bin', NODE_PATH: path.join(pluginDir, 'node_modules') })
            }
        );
    });

    it('should wrap a failure to start the utility process into a readable error', () => {
        host.start.mockImplementation(() => { throw new Error('utility process unavailable'); });

        expect(() => new PtyService('/bin/sh', '/cwd', 80, 24, runtime())).toThrow(/utility process unavailable/);
    });

    it('should queue input, resize and queries until the port arrives, then send them in order', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());

        service.write('ls\r');
        service.resize(0, 40);
        void service.getForegroundProcess();
        await connect();

        expect(port.sent).toEqual([
            { type: 'input', data: 'ls\r' },
            { type: 'resize', cols: 1, rows: 40 },
            { type: 'query-process', id: 1 }
        ]);
    });

    it('should forward output messages to the onData callback', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());
        const onData = vi.fn();
        service.onData(onData);
        await connect();

        port.receive({ type: 'data', data: '中文 output' });

        expect(onData).toHaveBeenCalledWith('中文 output');
    });

    it('should resolve foreground process queries from reply messages', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());
        await connect();

        const result = service.getForegroundProcess();
        port.receive({ type: 'process', id: 1, name: null });

        await expect(result).resolves.toBeNull();
    });

    it('should show bridge errors in red and not add a "session closed" message after them', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());
        const onData = vi.fn();
        service.onData(onData);
        await connect();

        port.receive({ type: 'error', message: 'Failed to load node-pty' });
        port.receive({ type: 'exit', code: 1 });

        expect(onData).toHaveBeenCalledTimes(1);
        expect(onData).toHaveBeenCalledWith('\r\n\x1b[31mFailed to load node-pty\x1b[0m\r\n');
        expect(service.isTerminated).toBe(true);
    });

    it('should end the session when the shell exits: notify the UI, close the port and stop the process', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());
        const onData = vi.fn();
        service.onData(onData);
        await connect();

        port.receive({ type: 'data', data: 'bye' });
        port.receive({ type: 'exit', code: 0 });

        expect(onData.mock.calls.map(call => call[0])).toEqual(['bye', expect.stringContaining('Exit Code: 0')]);
        expect(service.isTerminated).toBe(true);
        expect(port.closed).toBe(true);
        expect(utilityChild.kill).toHaveBeenCalled();
    });

    it('should end the session when the utility process dies without reporting an exit code', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());
        const onData = vi.fn();
        service.onData(onData);
        await connect();

        port.closeFromBridge();

        expect(service.isTerminated).toBe(true);
        expect(onData).toHaveBeenCalledWith(expect.stringContaining('[Terminal session closed'));
    });

    it('dispose should close the port, stop the process and ignore further input', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());
        await connect();

        service.dispose();
        service.write('late');

        expect(port.closed).toBe(true);
        expect(utilityChild.kill).toHaveBeenCalledTimes(1);
        expect(port.sent).toEqual([]);
    });

    it('should close a port that arrives after dispose', async () => {
        const service = new PtyService('/bin/sh', '/cwd', 80, 24, runtime());

        service.dispose();
        await connect();

        expect(port.closed).toBe(true);
        expect(port.sent).toEqual([]);
    });
});
