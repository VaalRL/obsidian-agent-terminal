/**
 * 以 Electron utilityProcess 執行 bridge.js：不需要系統 Node.js，也不受 RunAsNode fuse 影響
 * (Obsidian 關閉了該 fuse，ELECTRON_RUN_AS_NODE 無效)。
 *
 * utilityProcess 只能由主程序建立，外掛透過 Obsidian 提供的 remote 模組呼叫。remote 每次呼叫都是同步 IPC，
 * 所以只用來建立連線：開一個 MessageChannelMain，一端交給 bridge，另一端送到本視窗，
 * 之後的輸入輸出都直接走 MessagePort。
 */
import electron from 'electron';

/** 渲染端 (DOM) 的 MessagePort；utility process 結束時觸發 'close' */
export interface BridgePort {
    postMessage(message: unknown): void;
    close(): void;
    onmessage: ((event: { data: unknown }) => void) | null;
    addEventListener(type: 'close', listener: () => void): void;
}

export interface UtilityChild {
    kill(): void;
}

export interface UtilityStartOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export interface UtilityHost {
    start(modulePath: string, args: string[], options: UtilityStartOptions): { child: UtilityChild; port: Promise<BridgePort> };
}

interface MainChild extends UtilityChild {
    postMessage(message: unknown, transfer: unknown[]): void;
}

/** 只宣告用到的 Electron API */
export interface ElectronLike {
    ipcRenderer: {
        once(channel: string, listener: (event: { ports: BridgePort[] }) => void): unknown;
    };
    remote?: {
        utilityProcess?: {
            fork(modulePath: string, args: string[], options: object): MainChild;
        };
        MessageChannelMain?: new () => { port1: unknown; port2: unknown };
        getCurrentWebContents?: () => { postMessage(channel: string, message: unknown, transfer: unknown[]): void };
    };
}

function loadElectron(): ElectronLike | null {
    return (electron as ElectronLike | undefined) ?? null;
}

let nextChannelId = 0;

/** Obsidian 沒有提供 remote.utilityProcess 時回傳 null */
export function electronUtilityHost(electron: ElectronLike | null = loadElectron()): UtilityHost | null {
    const remote = electron?.remote;
    const utilityProcess = remote?.utilityProcess;
    const MessageChannelMain = remote?.MessageChannelMain;
    const getCurrentWebContents = remote?.getCurrentWebContents;
    if (!electron?.ipcRenderer || !utilityProcess || !MessageChannelMain || !getCurrentWebContents) return null;
    const { ipcRenderer } = electron;

    return {
        start(modulePath, args, options) {
            const channel = `agent-terminal-bridge-port-${++nextChannelId}-${Date.now()}`;
            const port = new Promise<BridgePort>((resolve) => {
                ipcRenderer.once(channel, (event) => resolve(event.ports[0]));
            });
            const child = utilityProcess.fork(modulePath, args, {
                cwd: options.cwd,
                env: options.env,
                serviceName: 'Agent Terminal'
            });
            const { port1, port2 } = new MessageChannelMain();
            child.postMessage(null, [port2]);
            getCurrentWebContents().postMessage(channel, null, [port1]);
            return { child: { kill: () => child.kill() }, port };
        }
    };
}
