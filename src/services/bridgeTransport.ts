/**
 * bridge 與外掛之間的傳輸方式：
 * - stdio：以 child_process 啟動 (系統 node 或 Obsidian 的 Electron)，輸入輸出走 stdin/stdout，控制訊息走 IPC
 * - port：以 Electron utilityProcess 啟動，所有訊息走外掛傳來的 MessagePort (不受 RunAsNode fuse 影響)
 */

/** 外掛 → bridge (port 模式全部走 MessagePort；stdio 模式的 input 走 stdin，其餘走 IPC) */
export type ToBridgeMessage =
    | { type: 'input'; data: string }
    | { type: 'resize'; cols: number; rows: number }
    | { type: 'query-process'; id: number };

/** bridge → 外掛 (port 模式；stdio 模式只有 process 走 IPC，其餘以 stdout/stderr/結束碼表示) */
export type FromBridgeMessage =
    | { type: 'data'; data: string }
    | { type: 'process'; id: number; name: string | null }
    | { type: 'error'; message: string }
    | { type: 'exit'; code: number };

export interface BridgeTransport {
    onInput(callback: (data: string) => void): void;
    /** resize、query-process 等控制訊息 */
    onControl(callback: (msg: unknown) => void): void;
    /** 外掛端關閉連線 (關閉終端機、Obsidian 重新載入)；回呼執行完後程序結束 */
    onClose(callback: () => void): void;
    sendData(data: string): void;
    reply(msg: FromBridgeMessage): void;
    /** 回報錯誤並結束 */
    fail(message: string): void;
    /** shell 已結束：確保輸出都送達後結束 */
    exit(code: number): void;
}

/** Electron 的 MessagePortMain (utility process 端) */
export interface MainPortLike {
    postMessage(message: unknown): void;
    start(): void;
    on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
}

/** utility process 的 process.parentPort：外掛以第一個訊息轉交 MessagePort */
export interface ParentPortLike {
    once(event: 'message', listener: (event: { ports: MainPortLike[] }) => void): unknown;
}

export function receivePort(parentPort: ParentPortLike): Promise<MainPortLike> {
    return new Promise((resolve) => {
        parentPort.once('message', (event) => resolve(event.ports[0]));
    });
}

function runAll(callbacks: (() => void)[]): void {
    for (const callback of callbacks) {
        try { callback(); } catch { /* 繼續清理其他資源 */ }
    }
}

export function createPortTransport(
    port: MainPortLike,
    exitProcess: (code: number) => void = (code) => process.exit(code)
): BridgeTransport {
    const inputCallbacks: ((data: string) => void)[] = [];
    const controlCallbacks: ((msg: unknown) => void)[] = [];
    const closeCallbacks: (() => void)[] = [];

    port.on('message', ({ data }) => {
        const msg = data as ToBridgeMessage;
        if (msg?.type === 'input') {
            inputCallbacks.forEach(callback => callback(msg.data));
        } else {
            controlCallbacks.forEach(callback => callback(msg));
        }
    });
    port.on('close', () => {
        runAll(closeCallbacks);
        exitProcess(0);
    });
    port.start();

    const send = (msg: FromBridgeMessage) => port.postMessage(msg);
    return {
        onInput: (callback) => { inputCallbacks.push(callback); },
        onControl: (callback) => { controlCallbacks.push(callback); },
        onClose: (callback) => { closeCallbacks.push(callback); },
        sendData: (data) => send({ type: 'data', data }),
        reply: send,
        fail: (message) => {
            send({ type: 'error', message });
            send({ type: 'exit', code: 1 });
        },
        // 立刻結束程序可能丟掉還在傳送中的訊息：只回報結束碼，外掛收到後會關閉 port，程序隨之結束
        exit: (code) => send({ type: 'exit', code })
    };
}

export function createStdioTransport(): BridgeTransport {
    const closeCallbacks: (() => void)[] = [];
    const close = () => {
        runAll(closeCallbacks);
        process.exit(0);
    };
    // 父程序結束或送出終止訊號時清理 PTY
    process.on('SIGTERM', close);
    process.on('SIGHUP', close);
    process.stdin.on('end', close);

    // 以 utf8 解碼 (Node 內部使用 StringDecoder)，被切在 chunk 邊界的多位元組字元會等下一個 chunk 補齊，不會變成 U+FFFD
    process.stdin.setEncoding('utf8');

    return {
        onInput: (callback) => {
            process.stdin.on('data', (data: string) => {
                if (data) callback(data);
            });
        },
        onControl: (callback) => { process.on('message', callback); },
        onClose: (callback) => { closeCallbacks.push(callback); },
        sendData: (data) => { process.stdout.write(data); },
        reply: (msg) => { process.send?.(msg); },
        // 錯誤一律以 "ERROR: " 開頭寫到 stderr，PtyService 會把這類訊息顯示在終端機畫面上
        // 訊息壓成單行，因為 PtyService 是逐行比對 "ERROR:" 前綴
        fail: (message) => {
            process.stderr.write(`ERROR: ${message.replace(/\s*\r?\n\s*/g, ' ')}\n`);
            process.exit(1);
        },
        // stdout 寫入 pipe 在 macOS 上是非同步的，直接 process.exit 會截斷最後的輸出：
        // 送出一個空寫入，它的 callback 會在先前所有資料寫出後才呼叫，再結束
        exit: (code) => { process.stdout.write('', () => process.exit(code)); }
    };
}
