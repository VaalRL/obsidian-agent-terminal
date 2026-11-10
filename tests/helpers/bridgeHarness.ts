import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { buildSync } from 'esbuild';

// 假的 node-pty：把收到的每次 write 以 [..] 包起來回傳 (可看出 bridge 每次交給 PTY 的內容)；
// 收到 FLOOD 時一次輸出大量資料後立刻觸發 onExit，模擬「程式輸出完就結束」
const FAKE_NODE_PTY = `
exports.spawn = function () {
    const dataCallbacks = [];
    const exitCallbacks = [];
    return {
        process: 'fake-shell',
        onData(cb) { dataCallbacks.push(cb); },
        onExit(cb) { exitCallbacks.push(cb); },
        resize() {},
        kill() {},
        write(data) {
            if (data === 'FLOOD') {
                const big = 'x'.repeat(${4 * 1024 * 1024}) + 'END';
                dataCallbacks.forEach(cb => cb(big));
                exitCallbacks.forEach(cb => cb({ exitCode: 0 }));
                return;
            }
            dataCallbacks.forEach(cb => cb('[' + data + ']'));
        }
    };
};
`;

// 模擬 macOS 上 pipe 的非同步寫入：process.stdout.write 先排入佇列，稍後才真正寫出 (callback 也在寫出後才呼叫)。
// Windows 與 Linux 的 pipe 是同步寫入，無法直接重現「process.exit 截斷未寫出資料」
const ASYNC_STDOUT_SHIM = `
const realWrite = process.stdout.write.bind(process.stdout);
const queue = [];
let timer = null;
process.stdout.write = (chunk, encoding, callback) => {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    queue.push([chunk, encoding, callback]);
    if (!timer) timer = setTimeout(() => {
        timer = null;
        for (const [c, e, cb] of queue.splice(0)) realWrite(c, e, cb);
    }, 50);
    return false;
};
`;

export interface BridgeHarness {
    child: ChildProcess;
    /** 收到的全部 stdout (以 utf8 解碼整段，不受 chunk 邊界影響) */
    output(): string;
    /** 等待 bridge 結束，回傳結束碼 */
    exited: Promise<number | null>;
    cleanup(): Promise<void>;
}

/** 以 esbuild 打包 src/services/bridge.ts，搭配假的 node-pty 用系統 node 實際執行 */
export function startBridge(options: { asyncStdout?: boolean } = {}): BridgeHarness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-bridge-'));
    const bundle = buildSync({
        entryPoints: [path.join(__dirname, '..', '..', 'src', 'services', 'bridge.ts')],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        external: ['node-pty'],
        write: false
    });
    const bridgePath = path.join(dir, 'bridge.js');
    fs.writeFileSync(bridgePath, bundle.outputFiles[0].text);
    const ptyDir = path.join(dir, 'node_modules', 'node-pty');
    fs.mkdirSync(ptyDir, { recursive: true });
    fs.writeFileSync(path.join(ptyDir, 'index.js'), FAKE_NODE_PTY);

    const preload: string[] = [];
    if (options.asyncStdout) {
        const shimPath = path.join(dir, 'async-stdout.js');
        fs.writeFileSync(shimPath, ASYNC_STDOUT_SHIM);
        preload.push('-r', shimPath);
    }
    const child = spawn(process.execPath, [...preload, bridgePath, 'fake-shell', dir, '80', '24'], {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_PATH: path.join(dir, 'node_modules') },
        windowsHide: true
    });
    const chunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

    return {
        child,
        output: () => Buffer.concat(chunks).toString('utf8'),
        exited,
        cleanup: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await exited;
            // Windows 上程序剛結束時檔案可能仍被鎖住，刪不掉就留給系統暫存清理
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 略過 */ }
        }
    };
}
