import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Obsidian 官方 CLI (1.12.4 起，設定 → 一般 → Command line interface 啟用後註冊)。
 * 讓終端機裡的 AI agent 可以控制 Obsidian，例如 `obsidian daily`、`obsidian command id=…`。
 *
 * 註冊位置：
 * - macOS：/usr/local/bin/obsidian (指向 App 內的 obsidian-cli)
 * - Linux：~/.local/bin/obsidian
 * - Windows：Obsidian.exe 同資料夾的 Obsidian.com，並把該資料夾加入使用者 PATH
 *
 * 從 Dock 開啟的 macOS App、只在登入 shell 才加入 ~/.local/bin 的 Linux、
 * 以及註冊後尚未重開 Obsidian 的 Windows，Obsidian (與終端機) 的 PATH 都可能還找不到它，
 * 所以除了 PATH 也檢查註冊位置；找到但不在 PATH 時，由外掛把資料夾加進終端機的 PATH。
 */
export type CliStatus =
    | { state: 'available'; path: string; dir: string; onPath: boolean }
    | { state: 'not-registered' }
    | { state: 'outdated' };

/** 偵測時需要的環境資訊 (測試時可替換) */
export interface CliHost {
    platform: string;
    env: NodeJS.ProcessEnv;
    execPath: string; // Obsidian 執行檔
    homedir: string;
    appVersionOk: boolean; // Obsidian 版本是否 >= 1.12.4
    exists: (p: string) => boolean;
}

export const MIN_CLI_VERSION = '1.12.4';

function pathApi(platform: string) {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** Windows 的環境變數名稱不分大小寫 (通常是 Path)；找出實際使用的鍵 */
function pathKey(env: NodeJS.ProcessEnv, platform: string): string {
    if (platform !== 'win32') return 'PATH';
    return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path';
}

function samePath(a: string, b: string, platform: string): boolean {
    const p = pathApi(platform);
    const normalize = (x: string) => p.normalize(x).replace(/[\\/]+$/, '');
    return platform === 'win32'
        ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
        : normalize(a) === normalize(b);
}

export function detectObsidianCli(host: CliHost): CliStatus {
    if (!host.appVersionOk) return { state: 'outdated' };

    const p = pathApi(host.platform);
    const isWin = host.platform === 'win32';
    // Windows 的 obsidian 指令解析為 Obsidian.com (Obsidian.exe 是 GUI 本體，不是 CLI)
    const fileName = isWin ? 'Obsidian.com' : 'obsidian';

    const pathDirs = (host.env[pathKey(host.env, host.platform)] ?? '')
        .split(isWin ? ';' : ':')
        .filter(Boolean);
    for (const dir of pathDirs) {
        const candidate = p.join(dir, fileName);
        if (host.exists(candidate)) return { state: 'available', path: candidate, dir, onPath: true };
    }

    const registered = isWin
        ? p.join(p.dirname(host.execPath), fileName)
        : host.platform === 'darwin'
            ? '/usr/local/bin/obsidian'
            : p.join(host.homedir, '.local', 'bin', 'obsidian');
    if (host.exists(registered)) {
        const dir = p.dirname(registered);
        return { state: 'available', path: registered, dir, onPath: pathDirs.some(d => samePath(d, dir, host.platform)) };
    }

    return { state: 'not-registered' };
}

/** 把資料夾加到 PATH 最前面 (回傳新物件；已存在則不重複加入) */
export function prependPath(env: NodeJS.ProcessEnv, dir: string, platform: string): NodeJS.ProcessEnv {
    const key = pathKey(env, platform);
    const separator = platform === 'win32' ? ';' : ':';
    const current = env[key] ?? '';
    const dirs = current.split(separator).filter(Boolean);
    if (dirs.some(d => samePath(d, dir, platform))) return { ...env };
    return { ...env, [key]: current ? `${dir}${separator}${current}` : dir };
}

/** 以目前的 Obsidian 程序建立偵測環境 (appVersionOk 由呼叫端用 requireApiVersion(MIN_CLI_VERSION) 取得) */
export function currentCliHost(appVersionOk: boolean): CliHost {
    return {
        platform: process.platform,
        env: process.env,
        execPath: process.execPath,
        homedir: os.homedir(),
        appVersionOk,
        exists: (p: string) => fs.existsSync(p)
    };
}
