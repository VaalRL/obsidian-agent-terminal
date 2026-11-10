import * as os from 'os';
import * as fs from 'fs/promises';
import { constants, realpathSync } from 'fs';
import * as path from 'path';

export interface ShellPreset {
    name: string; // 顯示名稱
    path: string; // 執行檔絕對路徑
}

// /etc/shells 中常見但不適合當互動 shell 的項目 (rbash 是受限 bash，禁止 cd)
const NON_INTERACTIVE_SHELLS = new Set(['tmux', 'screen', 'nologin', 'false', 'rbash']);

export class EnvironmentService {
    /**
     * 取得作業系統預設 Shell
     * Windows: 優先看 %ComSpec% 或 fallback 為 cmd.exe/powershell.exe
     * macOS/Linux: 優先看 $SHELL 或 fallback 為 /bin/bash 或 /bin/zsh
     */
    static detectDefaultShell(): string {
        const isWin = os.platform() === 'win32';
        if (isWin) {
            return process.env.COMSPEC || process.env.ComSpec || 'cmd.exe';
        } else {
            return process.env.SHELL || '/bin/bash';
        }
    }

    /**
     * 偵測系統上已安裝的 shell，供設定頁下拉選單使用。
     * 只回傳實際存在且可執行的項目，同名 shell 只保留第一個。
     */
    static async detectShellPresets(): Promise<ShellPreset[]> {
        const candidates = os.platform() === 'win32'
            ? this.windowsShellCandidates()
            : await this.unixShellCandidates();

        const presets: ShellPreset[] = [];
        const seen = new Set<string>();
        for (const candidate of candidates) {
            if (seen.has(candidate.name)) continue;
            if (await this.validateShellPath(candidate.path)) {
                presets.push(candidate);
                seen.add(candidate.name);
            }
        }
        return presets;
    }

    private static windowsShellCandidates(): ShellPreset[] {
        const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const system32 = path.win32.join(systemRoot, 'System32');

        return [
            { name: 'PowerShell 7', path: path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe') },
            { name: 'Windows PowerShell', path: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
            { name: 'Command Prompt', path: process.env.COMSPEC || process.env.ComSpec || path.win32.join(system32, 'cmd.exe') },
            { name: 'WSL', path: path.win32.join(system32, 'wsl.exe') },
            { name: 'Git Bash', path: path.win32.join(programFiles, 'Git', 'bin', 'bash.exe') }
        ];
    }

    private static async unixShellCandidates(): Promise<ShellPreset[]> {
        let paths: string[];
        try {
            const content = await fs.readFile('/etc/shells', 'utf8');
            paths = content.split('\n').map(line => line.trim()).filter(line => line.startsWith('/'));
        } catch {
            paths = ['/bin/zsh', '/bin/bash', '/bin/sh'];
        }

        // 使用者目前的登入 shell 排第一
        if (process.env.SHELL) paths.unshift(process.env.SHELL);

        return paths
            .map(p => ({ name: path.posix.basename(p), path: p }))
            .filter(preset => !NON_INTERACTIVE_SHELLS.has(preset.name));
    }

    /**
     * 依 shell 種類產生切換目錄的指令 (含 Enter)。
     * 路徑一律以「不展開變數」的方式引用，避免資料夾名稱中的 $、` 被 shell 執行。
     */
    static buildCdCommand(shellPath: string, dir: string): string {
        const shell = this.normalizeProgramName(shellPath);

        if (shell === 'cmd') {
            // cmd 在雙引號內仍會展開 %VAR%，而 ^ 在引號內是字面字元，無法直接跳脫：
            // 每個 % 之後先關閉引號、以 ^ 跳脫下一個字元、再重新開引號 (例如 %PATH% → %"^P"ATH%)。
            // 這樣任何變數名稱都以 " 開頭 (不可能已定義)，互動模式下未定義的變數原樣保留；cd 會去掉路徑中的引號。
            // 已以實際 cmd.exe 驗證；延遲展開 (!VAR!) 預設關閉，不處理。
            return `cd /d "${dir.replace(/%(.)/gs, '%"^$1"')}"\r`;
        }
        if (shell === 'powershell' || shell === 'pwsh') {
            return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'\r`;
        }
        // WSL：shell 在 Linux 內執行，Windows 路徑要轉成 Linux 路徑
        const target = shell === 'wsl' ? this.toWslPath(dir) : dir;
        // POSIX shell (bash/zsh/fish/sh)：單引號內不展開，' 以 '\'' 跳脫
        return `cd '${target.replace(/'/g, `'\\''`)}'\r`;
    }

    /**
     * 把 Windows 路徑轉成 WSL 內的路徑 (純字串轉換，不另外啟動 wslpath)：
     * - C:\Users\me → /mnt/c/Users/me (磁碟代號轉小寫，WSL 預設掛載點)
     * - \\wsl$\<發行版>\home\me、\\wsl.localhost\<發行版>\home\me → /home/me
     * 其他路徑 (一般網路共用、已是 Linux 路徑) 原樣回傳。
     * 限制：/etc/wsl.conf 自訂 automount root 時，/mnt 前綴會不正確。
     */
    static toWslPath(dir: string): string {
        const drive = /^([a-zA-Z]):[\\/]?(.*)$/.exec(dir);
        if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
        const share = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/][^\\/]+(.*)$/i.exec(dir);
        if (share) return share[1].replace(/\\/g, '/') || '/';
        return dir;
    }

    /**
     * 清空 shell 目前輸入行的按鍵序列 (送出 quick command 前使用，避免接在使用者打到一半的字後面)：
     * - cmd.exe 與 Windows 上的 PowerShell (PSReadLine Windows 模式)：Esc
     * - bash / zsh / fish / 非 Windows 的 PowerShell (Emacs 模式)：Ctrl+E 移到行尾，再 Ctrl+U 刪到行首
     */
    static buildClearLineSequence(shellPath: string, platform: string = process.platform): string {
        const shell = this.normalizeProgramName(shellPath);
        if (shell === 'cmd') return '\x1b';
        if ((shell === 'powershell' || shell === 'pwsh') && platform === 'win32') return '\x1b';
        return '\x05\x15';
    }

    /**
     * 判斷終端機前景程式是否就是設定的 shell (代表 shell 正在等待指令)。
     * 無法判斷 (null/空字串，例如 Windows) 時一律回傳 false。
     */
    static isShellProcess(
        shellPath: string,
        foregroundProcess: string | null | undefined,
        host: { realpath?: (p: string) => string; platform?: string } = {}
    ): boolean {
        if (!foregroundProcess) return false;
        return this.shellProgramNames(shellPath, host).has(this.normalizeProgramName(foregroundProcess));
    }

    /**
     * 設定的 shell 在前景時可能顯示的程式名稱。macOS 的 node-pty 回報實際執行檔名稱 (p_comm)，所以除了設定的名稱，
     * 還包含 symlink 指向的實際程式；macOS 的 /bin/sh 是啟動程式，實際執行 /private/var/select/sh 指向的 shell。
     * (Linux 回報的是 argv[0]，與設定的名稱相同)
     */
    private static shellProgramNames(
        shellPath: string,
        { realpath = realpathSync, platform = process.platform }: { realpath?: (p: string) => string; platform?: string }
    ): Set<string> {
        const names = new Set([this.normalizeProgramName(shellPath)]);
        const addRealName = (p: string) => {
            try {
                names.add(this.normalizeProgramName(realpath(p)));
            } catch { /* 不存在或無法解析：只用設定的名稱 */ }
        };
        addRealName(shellPath);
        if (platform === 'darwin' && names.has('sh')) addRealName('/private/var/select/sh');
        return names;
    }

    /**
     * 取出程式名稱：去路徑、轉小寫、去 .exe、去 login shell 的前置 "-" (如 "-zsh")
     */
    private static normalizeProgramName(nameOrPath: string): string {
        // win32.basename 同時接受 / 與 \，可在任何平台解析 Windows 路徑
        return path.win32.basename(nameOrPath).toLowerCase().replace(/\.exe$/, '').replace(/^-/, '');
    }

    /**
     * 驗證檔案路徑是否有效且具備執行權限 (利用 fs.access)
     */
    static async validateShellPath(shellPath: string): Promise<boolean> {
        if (!shellPath) return false;
        try {
            await fs.access(shellPath, constants.R_OK | constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
}
