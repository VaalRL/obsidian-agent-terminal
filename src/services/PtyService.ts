import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { BridgeRuntime, RuntimeResolver } from './RuntimeResolver';
import { ORIGINAL_NODE_PATH_VAR } from './shellEnv';
import { BridgePort, UtilityChild, UtilityHost } from './UtilityProcessHost';
import type { FromBridgeMessage, ToBridgeMessage } from './bridgeTransport';

interface ProcessReply {
    type: 'process';
    id: number;
    name: string | null;
}

/**
 * 前景程式查詢結果：
 * - string：前景程式名稱
 * - null：bridge 回報無法判斷 (Windows 的 node-pty 不提供)
 * - undefined：沒有收到回覆 (逾時、bridge 尚未就緒、已結束)，不能當成 shell 閒置
 */
export type ForegroundProcess = string | null | undefined;

function isProcessReply(msg: unknown): msg is ProcessReply {
    return typeof msg === 'object' && msg !== null
        && (msg as ProcessReply).type === 'process'
        && typeof (msg as ProcessReply).id === 'number';
}

export class PtyService {
    private child: ChildProcess | null = null;
    // Electron utility process 模式 (見 startUtilityProcess)
    private utilityChild: UtilityChild | null = null;
    private port: BridgePort | null = null;
    private pendingToBridge: ToBridgeMessage[] = [];
    private isDisposed: boolean = false;
    private hasFailed: boolean = false;
    private onDataCallback: ((data: string) => void) | null = null;
    // 等待 bridge 回覆前景程式查詢的 resolver (以查詢 id 對應)
    private pendingProcessQueries = new Map<number, (name: ForegroundProcess) => void>();
    private nextQueryId = 0;
    private static bridgePath: string = '';

    /**
     * 初始化橋接路徑：由 Plugin 傳入外掛資料夾。
     * 帶入 bridgeSource (內嵌於 main.js 的 bridge 程式碼) 時，會先寫成 bridge.js —
     * 社群外掛商店只會安裝 main.js/manifest.json/styles.css，bridge.js 必須由外掛自己產生。
     */
    static initBridge(pluginDirPath: string, bridgeSource?: string) {
        const potentialPath = path.join(pluginDirPath, 'bridge.js');
        if (bridgeSource !== undefined) {
            this.writeBridgeIfChanged(potentialPath, bridgeSource);
        }
        if (fs.existsSync(potentialPath)) {
            this.bridgePath = potentialPath;
        } else {
            console.error(`[AgentTerminal] Bridge file not found: ${potentialPath}`);
            // 嘗試從當前 __dirname 尋找 (最後手段)
            const fallbackPath = path.join(__dirname, 'bridge.js');
            if (fs.existsSync(fallbackPath)) {
                this.bridgePath = fallbackPath;
            }
        }
    }

    /** 內容相同時不重寫 (避免每次啟動 Obsidian 都寫檔) */
    private static writeBridgeIfChanged(filePath: string, source: string): void {
        try {
            if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === source) return;
            fs.writeFileSync(filePath, source, 'utf8');
        } catch (error) {
            console.error(`[AgentTerminal] Failed to write bridge.js: ${filePath}`, error);
        }
    }

    constructor(
        shellPath: string,
        cwd: string,
        cols: number = 80,
        rows: number = 24,
        runtime: BridgeRuntime = RuntimeResolver.systemNode()
    ) {
        if (!PtyService.bridgePath) {
            throw new Error('Terminal bridge (bridge.js) was not found. Try reinstalling the plugin.');
        }

        // 再次確認檔案是否存在與可讀取
        try {
            fs.accessSync(PtyService.bridgePath, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`Cannot read the terminal bridge at ${PtyService.bridgePath}. Check that the file exists and is readable.`, { cause: error });
        }
        
        const args = [shellPath, cwd, cols.toString(), rows.toString()];
        const bridgeDir = path.dirname(PtyService.bridgePath);
        const env = {
            ...runtime.env,
            // 確保 bridge.js 的 require 能找到 node_modules；使用者原本的 NODE_PATH 交給 bridge 還原給 shell
            NODE_PATH: path.join(bridgeDir, 'node_modules'),
            ...(runtime.env.NODE_PATH ? { [ORIGINAL_NODE_PATH_VAR]: runtime.env.NODE_PATH } : {})
        };

        try {
            // 以選定的 runtime (見 RuntimeResolver) 啟動橋接器
            if (runtime.kind === 'utility') {
                this.startUtilityProcess(runtime.host, args, bridgeDir, env);
            } else {
                this.startChildProcess(runtime.command, args, bridgeDir, env);
            }
        } catch (error) {
            console.error('[AgentTerminal] Failed to spawn bridge process:', error);
            this.isDisposed = true;
            throw new Error(`Failed to start bridge process.\n${(error as Error).message}`, { cause: error });
        }
    }

    /** 以 child_process 啟動 (系統 node 或 Obsidian 的 Electron)：輸入輸出走 stdio，控制訊息走 IPC */
    private startChildProcess(command: string, args: string[], bridgeDir: string, env: NodeJS.ProcessEnv): void {
        this.child = spawn(command, [PtyService.bridgePath, ...args], {
            cwd: bridgeDir,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'], // 使用 IPC 管道處理 resize
            windowsHide: true, // Windows 上不要跳出 node.exe 的主控台視窗
            env
        });

        // 接收輸出：以 StringDecoder 解碼，被切在 chunk 邊界的多位元組 UTF-8 字元 (中文、方框字元)
        // 會等下一個 chunk 補齊，不會變成 U+FFFD
        const stdoutDecoder = new StringDecoder('utf8');
        this.child.stdout?.on('data', (data: Buffer) => {
            this.emitData(stdoutDecoder.write(data));
        });

        // 接收錯誤：bridge 以 "ERROR:" 開頭回報的訊息 (見 bridgeTransport.ts) 轉給 UI，其餘只記錄。
        // 一行可能被切成多個 chunk，收到換行前先暫存
        const stderrDecoder = new StringDecoder('utf8');
        let stderrPending = '';
        this.child.stderr?.on('data', (data: Buffer) => {
            const text = stderrDecoder.write(data);
            if (!text) return;
            console.error('[AgentTerminal Bridge Error]', text);
            const lines = (stderrPending + text).split(/\r?\n/);
            stderrPending = lines.pop() ?? '';
            for (const line of lines) {
                if (line.startsWith('ERROR:')) {
                    this.notifyError(line.slice('ERROR:'.length).trim());
                }
            }
        });

        // bridge 透過 IPC 回覆前景程式查詢 (見 getForegroundProcess)
        this.child.on('message', (msg: unknown) => this.handleProcessReply(msg));

        // 子進程結束後仍寫入 stdin 會觸發 EPIPE，沒有監聽器會變成未捕捉例外
        this.child.stdin?.on('error', (error) => {
            console.error('[AgentTerminal] Bridge stdin error:', error);
            this.dispose();
        });

        // spawn 失敗 (找不到 node、權限不足等) 是以非同步 'error' 事件回報，不會進入 constructor 的 catch
        this.child.on('error', (error: NodeJS.ErrnoException) => {
            console.error('[AgentTerminal] Bridge process error:', error);
            this.hasFailed = true;
            this.dispose();
            this.notifyError(PtyService.describeSpawnError(error));
        });

        // 用 'close' 而不是 'exit'：'exit' 可能早於 stdout 最後一段資料，'close' 在 stdio 都關閉後才觸發
        this.child.on('close', (code) => this.handleBridgeClosed(code));
    }

    /**
     * 以 Electron utilityProcess 啟動 (見 UtilityProcessHost)：所有訊息走 MessagePort。
     * port 送達前的輸入與控制訊息先排隊，送達後依序送出
     */
    private startUtilityProcess(host: UtilityHost, args: string[], bridgeDir: string, env: NodeJS.ProcessEnv): void {
        const { child, port } = host.start(PtyService.bridgePath, args, { cwd: bridgeDir, env });
        this.utilityChild = child;
        void port.then((connected) => {
            if (this.isDisposed) {
                connected.close();
                return;
            }
            this.port = connected;
            connected.onmessage = (event) => this.handlePortMessage(event.data);
            // utility process 結束 (包括當機) 時 port 會關閉
            connected.addEventListener('close', () => this.handleBridgeClosed(null));
            for (const msg of this.pendingToBridge.splice(0)) connected.postMessage(msg);
        });
    }

    private handlePortMessage(data: unknown): void {
        const msg = data as FromBridgeMessage;
        switch (msg?.type) {
            case 'data':
                this.emitData(msg.data);
                break;
            case 'process':
                this.handleProcessReply(msg);
                break;
            case 'error':
                this.hasFailed = true;
                this.notifyError(msg.message);
                break;
            case 'exit':
                this.handleBridgeClosed(msg.code);
                break;
        }
    }

    private emitData(text: string): void {
        if (text && !this.isDisposed && this.onDataCallback) {
            this.onDataCallback(text);
        }
    }

    private handleProcessReply(msg: unknown): void {
        if (!isProcessReply(msg)) return;
        const resolve = this.pendingProcessQueries.get(msg.id);
        if (resolve) {
            this.pendingProcessQueries.delete(msg.id);
            resolve(typeof msg.name === 'string' ? msg.name : null);
        }
    }

    private handleBridgeClosed(code: number | null): void {
        // 主動 dispose (重啟/關閉) 或已顯示過錯誤時，不再輸出關閉訊息
        const shouldNotify = !this.isDisposed && !this.hasFailed;
        this.dispose();
        if (shouldNotify && this.onDataCallback) {
            this.onDataCallback(`\r\n[Terminal session closed (Exit Code: ${code})]\r\n`);
        }
    }

    /**
     * 將 spawn 錯誤轉為使用者看得懂、可據以排除問題的訊息
     */
    static describeSpawnError(error: NodeJS.ErrnoException): string {
        switch (error.code) {
            case 'ENOENT':
                return 'Node.js was not found. Agent Terminal runs its terminal bridge with the system "node" command. '
                    + 'Install Node.js (https://nodejs.org), make sure it is on your PATH, then restart Obsidian.';
            case 'EACCES':
            case 'EPERM':
                return 'Permission denied while starting the terminal. '
                    + 'Check whether antivirus or security software is blocking Obsidian from launching child processes.';
            default:
                return `Failed to start the terminal bridge: ${error.message}`;
        }
    }

    public onData(callback: (data: string) => void) {
        this.onDataCallback = callback;
    }

    private notifyError(message: string): void {
        if (this.onDataCallback) {
            this.onDataCallback(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
        }
    }

    public write(data: string): void {
        if (this.isDisposed) return;
        if (this.child) {
            this.child.stdin?.write(data);
        } else {
            this.postToBridge({ type: 'input', data });
        }
    }

    public resize(cols: number, rows: number): void {
        this.sendControl({ type: 'resize', cols: Math.max(1, cols), rows: Math.max(1, rows) });
    }

    /** 控制訊息：child_process 走 IPC (斷線時略過，回傳 false)，utility process 走 MessagePort */
    private sendControl(msg: ToBridgeMessage): boolean {
        if (this.isDisposed) return false;
        if (this.child) {
            if (!this.child.connected) return false;
            this.child.send(msg);
            return true;
        }
        if (!this.utilityChild) return false;
        this.postToBridge(msg);
        return true;
    }

    private postToBridge(msg: ToBridgeMessage): void {
        if (this.port) {
            this.port.postMessage(msg);
        } else {
            this.pendingToBridge.push(msg);
        }
    }

    /**
     * 查詢終端機目前的前景程式名稱 (例如 "bash"、"claude"、"vim")，見 ForegroundProcess：
     * bridge 回報無法判斷 (Windows) 時為 null；沒有回覆 (逾時、bridge 尚未就緒或已結束) 時為 undefined。
     */
    public getForegroundProcess(timeoutMs: number = 500): Promise<ForegroundProcess> {
        const id = ++this.nextQueryId;
        return new Promise((resolve) => {
            if (!this.sendControl({ type: 'query-process', id })) {
                resolve(undefined);
                return;
            }
            const timer = window.setTimeout(() => {
                this.pendingProcessQueries.delete(id);
                resolve(undefined);
            }, timeoutMs);

            this.pendingProcessQueries.set(id, (name) => {
                window.clearTimeout(timer);
                resolve(name);
            });
        });
    }

    public dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;

        for (const resolve of this.pendingProcessQueries.values()) resolve(undefined);
        this.pendingProcessQueries.clear();

        if (this.child) {
            this.child.kill();
            this.child = null;
        }
        this.pendingToBridge = [];
        this.port?.close();
        this.port = null;
        this.utilityChild?.kill();
        this.utilityChild = null;
    }
    
    public get isTerminated(): boolean {
        return this.isDisposed;
    }
}
