// Agent Terminal Bridge - Runs in a separate process (Electron utility process or Node.js)
// to bypass Electron's Renderer restrictions.

import { buildShellEnv, TERMINAL_NAME } from './shellEnv';
import { BridgeTransport, ParentPortLike, createPortTransport, createStdioTransport, receivePort } from './bridgeTransport';

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

interface ResizeMessage {
    type: 'resize';
    cols: number;
    rows: number;
}

function isResizeMessage(msg: unknown): msg is ResizeMessage {
    return typeof msg === 'object' && msg !== null && (msg as ResizeMessage).type === 'resize';
}

interface ProcessQuery {
    type: 'query-process';
    id: number;
}

function isProcessQuery(msg: unknown): msg is ProcessQuery {
    return typeof msg === 'object' && msg !== null && (msg as ProcessQuery).type === 'query-process';
}

// 只宣告 bridge 用到的 node-pty API
interface PtyProcess {
    process: string;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(callback: (data: string) => void): void;
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

interface NodePty {
    spawn(file: string, args: string[], options: object): PtyProcess;
}

async function run(transport: BridgeTransport): Promise<void> {
    // 從命令列參數獲取初始化資訊
    const shell = process.argv[2];
    const cwd = process.argv[3];
    const cols = parseInt(process.argv[4] || '80');
    const rows = parseInt(process.argv[5] || '24');

    let pty: NodePty;
    try {
        // 動態載入：node-pty 不存在或與 runtime 不相容時，回報可讀的錯誤而不是讓 bridge 直接結束
        pty = await import('node-pty');
    } catch (e) {
        transport.fail(`Failed to load node-pty. Make sure it is installed in the plugin folder and built for your Node.js version. (${errorMessage(e)})`);
        return;
    }

    let ptyProcess: PtyProcess;
    try {
        ptyProcess = pty.spawn(shell, [], {
            name: TERMINAL_NAME,
            cols: cols,
            rows: rows,
            cwd: cwd,
            // 移除 bridge 專用的環境變數並宣告色彩能力 (見 shellEnv.ts)
            env: buildShellEnv(process.env)
        });
    } catch (e) {
        transport.fail(`Failed to start shell "${shell}": ${errorMessage(e)}`);
        return;
    }

    transport.onInput((data) => ptyProcess.write(data));
    ptyProcess.onData((data) => transport.sendData(data));

    // 處理 Resize 與前景程式查詢
    transport.onControl((msg) => {
        if (isResizeMessage(msg)) {
            ptyProcess.resize(msg.cols, msg.rows);
        } else if (isProcessQuery(msg)) {
            // Windows 上 node-pty 的 process 只會回傳終端機名稱 (如 xterm-256color)，無法判斷前景程式，回報 null
            const name = process.platform === 'win32' ? null : ptyProcess.process;
            transport.reply({ type: 'process', id: msg.id, name });
        }
    });

    ptyProcess.onExit((event) => transport.exit(event.exitCode));
    transport.onClose(() => ptyProcess.kill());
}

// Electron utility process 會提供 process.parentPort，外掛以第一個訊息轉交 MessagePort
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) {
    void receivePort(parentPort).then((port) => run(createPortTransport(port)));
} else {
    void run(createStdioTransport());
}
