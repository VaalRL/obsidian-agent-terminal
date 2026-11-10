import { spawn } from 'child_process';
import { UtilityHost, electronUtilityHost } from './UtilityProcessHost';

/**
 * 執行 bridge.js 的 JavaScript runtime。
 * - utility：Obsidian 的 Electron utilityProcess (見 UtilityProcessHost)，使用者不需安裝任何東西
 * - electron：Obsidian 自己的執行檔加上 ELECTRON_RUN_AS_NODE=1 (RunAsNode fuse 未關閉的版本才可用)
 * - node：系統安裝的 Node.js (以上都不可用時的備援)
 */
export type BridgeRuntime =
    | { kind: 'utility'; host: UtilityHost; env: NodeJS.ProcessEnv }
    | { kind: 'electron' | 'node'; command: string; env: NodeJS.ProcessEnv };

type ExecutableRuntime = Extract<BridgeRuntime, { command: string }>;

/** 探測時需要的執行環境資訊 (預設為目前的 process，測試時可替換) */
export interface RuntimeHost {
    versions: { electron?: string; node?: string };
    execPath: string;
    env: NodeJS.ProcessEnv;
    /** 可用的 utilityProcess (Obsidian 有提供 remote 時) */
    utility?: UtilityHost | null;
}

function currentRuntimeHost(): RuntimeHost {
    return {
        versions: process.versions,
        execPath: process.execPath,
        env: process.env,
        utility: electronUtilityHost()
    };
}

export const NO_RUNTIME_MESSAGE =
    'Could not start the terminal: Obsidian\'s built-in runtime is not available on this system and Node.js was not found. '
    + 'Install Node.js (https://nodejs.org), make sure it is on your PATH, then restart the terminal.';

const PROBE_MARKER = '__AGENT_TERMINAL_RUNTIME_OK__';
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export class RuntimeResolver {
    private static cached: BridgeRuntime | null = null;
    // 探測進行中的 Promise：同時開啟多個終端機時共用同一次探測
    private static pending: Promise<BridgeRuntime | null> | null = null;

    /**
     * 依序探測可用的 runtime：Electron utilityProcess → Obsidian 內建 Electron → 系統 node。
     * 成功的結果會快取；都失敗時回傳 null 且不快取 (使用者安裝 Node 後重啟終端機即可重試)。
     * 探測進行中再呼叫時，共用同一次探測的結果。
     */
    static resolve(host: RuntimeHost = currentRuntimeHost(), timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<BridgeRuntime | null> {
        if (this.cached) return Promise.resolve(this.cached);
        if (!this.pending) {
            const pending = this.probeCandidates(host, timeoutMs).finally(() => {
                if (this.pending === pending) this.pending = null;
            });
            this.pending = pending;
        }
        return this.pending;
    }

    private static async probeCandidates(host: RuntimeHost, timeoutMs: number): Promise<BridgeRuntime | null> {
        // utilityProcess 由 Electron 主程序建立，不必啟動執行檔探測
        if (host.utility) {
            this.cached = { kind: 'utility', host: host.utility, env: this.withoutRunAsNode(host.env) };
            return this.cached;
        }
        for (const candidate of this.candidates(host)) {
            if (await this.probe(candidate, timeoutMs)) {
                this.cached = candidate;
                return candidate;
            }
        }
        return null;
    }

    static clearCache(): void {
        this.cached = null;
        this.pending = null;
    }

    /** 系統 Node.js runtime (不帶 ELECTRON_RUN_AS_NODE) */
    static systemNode(host: RuntimeHost = process): ExecutableRuntime {
        return { kind: 'node', command: 'node', env: this.withoutRunAsNode(host.env) };
    }

    private static withoutRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const result = { ...env };
        delete result.ELECTRON_RUN_AS_NODE;
        return result;
    }

    private static candidates(host: RuntimeHost): ExecutableRuntime[] {
        const candidates: ExecutableRuntime[] = [];
        if (host.versions.electron) {
            candidates.push({
                kind: 'electron',
                command: host.execPath,
                env: { ...host.env, ELECTRON_RUN_AS_NODE: '1' }
            });
        }
        candidates.push(this.systemNode(host));
        return candidates;
    }

    /**
     * 以 -e 執行一小段程式，確認此 runtime 真的能當 Node 使用。
     * 若 Obsidian 關閉了 RunAsNode fuse，執行檔會以一般 App 啟動並立刻結束 (單一實例)，不會印出標記。
     */
    private static probe(runtime: ExecutableRuntime, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            let output = '';
            let settled = false;
            const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve(ok);
            };

            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(runtime.command, ['-e', `process.stdout.write('${PROBE_MARKER}')`], {
                    env: runtime.env,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    windowsHide: true
                });
            } catch {
                resolve(false);
                return;
            }

            const timer = window.setTimeout(() => {
                child.kill();
                finish(false);
            }, timeoutMs);

            child.stdout?.on('data', (data: Buffer) => {
                output += data.toString();
                if (output.includes(PROBE_MARKER)) finish(true);
            });
            child.on('error', () => finish(false));
            // 'close' 在 stdout 讀完後才觸發；'exit' 可能早於標記輸出，誤判為不可用
            child.on('close', () => finish(output.includes(PROBE_MARKER)));
        });
    }
}
