import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EnvironmentService } from '../src/services/EnvironmentService';
import * as os from 'os';
import * as fs from 'fs/promises';

vi.mock('os');
vi.mock('fs/promises');

describe('EnvironmentService', () => {
    describe('detectDefaultShell', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            process.env = { ...originalEnv };
            vi.mocked(os.platform).mockReset();
        });

        afterAll(() => {
            process.env = originalEnv;
        });

        it('should return ComSpec on Windows', () => {
            vi.mocked(os.platform).mockReturnValue('win32');
            delete process.env.COMSPEC;
            process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
            
            const shell = EnvironmentService.detectDefaultShell();
            expect(shell).toBe('C:\\Windows\\System32\\cmd.exe');
        });

        it('should return SHELL on non-Windows', () => {
            vi.mocked(os.platform).mockReturnValue('darwin');
            process.env.SHELL = '/bin/zsh';
            
            const shell = EnvironmentService.detectDefaultShell();
            expect(shell).toBe('/bin/zsh');
        });
    });

    describe('validateShellPath', () => {
        beforeEach(() => {
            vi.mocked(fs.access).mockReset();
        });

        it('should return true for valid executable path', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            const isValid = await EnvironmentService.validateShellPath('/valid/path/to/shell');
            expect(isValid).toBe(true);
        });

        it('should return false for invalid or inaccessible path', async () => {
            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
            const isValid = await EnvironmentService.validateShellPath('/invalid/path');
            expect(isValid).toBe(false);
        });

        it('should return false for empty path', async () => {
            const isValid = await EnvironmentService.validateShellPath('');
            expect(isValid).toBe(false);
        });
    });

    describe('detectShellPresets', () => {
        const originalEnv = process.env;
        // 只有列在 existing 裡的路徑視為存在且可執行
        const existing = (paths: string[]) => {
            vi.mocked(fs.access).mockImplementation(async (p) => {
                if (!paths.includes(String(p))) throw new Error('ENOENT');
            });
        };

        beforeEach(() => {
            process.env = { ...originalEnv };
            vi.mocked(fs.access).mockReset();
            vi.mocked(fs.readFile).mockReset();
        });

        afterAll(() => {
            process.env = originalEnv;
        });

        describe('on Windows', () => {
            beforeEach(() => {
                vi.mocked(os.platform).mockReturnValue('win32');
                process.env.SystemRoot = 'C:\\Windows';
                process.env.ProgramFiles = 'C:\\Program Files';
                delete process.env.COMSPEC;
                process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
            });

            it('should list the installed Windows shells in a friendly order', async () => {
                existing([
                    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                    'C:\\Windows\\system32\\cmd.exe',
                    'C:\\Windows\\System32\\wsl.exe',
                    'C:\\Program Files\\Git\\bin\\bash.exe'
                ]);

                await expect(EnvironmentService.detectShellPresets()).resolves.toEqual([
                    { name: 'PowerShell 7', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
                    { name: 'Windows PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
                    { name: 'Command Prompt', path: 'C:\\Windows\\system32\\cmd.exe' },
                    { name: 'WSL', path: 'C:\\Windows\\System32\\wsl.exe' },
                    { name: 'Git Bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe' }
                ]);
            });

            it('should leave out shells that are not installed', async () => {
                existing(['C:\\Windows\\system32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);

                const names = (await EnvironmentService.detectShellPresets()).map(p => p.name);
                expect(names).toEqual(['Windows PowerShell', 'Command Prompt']);
            });
        });

        describe('on macOS / Linux', () => {
            beforeEach(() => {
                vi.mocked(os.platform).mockReturnValue('linux');
                process.env.SHELL = '/usr/bin/zsh';
            });

            it('should read /etc/shells, put $SHELL first and drop duplicates and non-shells', async () => {
                vi.mocked(fs.readFile).mockResolvedValue([
                    '# /etc/shells: valid login shells',
                    '/bin/sh',
                    '/bin/bash',
                    '/usr/bin/bash',
                    '/bin/zsh',
                    '/usr/bin/zsh',
                    '/usr/bin/tmux',
                    '/usr/bin/screen',
                    '/bin/rbash',
                    '',
                    '/usr/bin/fish'
                ].join('\n') as any);
                existing(['/bin/sh', '/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/usr/bin/tmux', '/usr/bin/screen', '/bin/rbash', '/usr/bin/fish']);

                await expect(EnvironmentService.detectShellPresets()).resolves.toEqual([
                    { name: 'zsh', path: '/usr/bin/zsh' },
                    { name: 'sh', path: '/bin/sh' },
                    { name: 'bash', path: '/bin/bash' },
                    { name: 'fish', path: '/usr/bin/fish' }
                ]);
                expect(fs.readFile).toHaveBeenCalledWith('/etc/shells', 'utf8');
            });

            it('should fall back to common shells when /etc/shells cannot be read', async () => {
                vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
                delete process.env.SHELL;
                existing(['/bin/bash', '/bin/sh']);

                const names = (await EnvironmentService.detectShellPresets()).map(p => p.name);
                expect(names).toEqual(['bash', 'sh']);
            });

            it('should leave out entries that do not exist', async () => {
                vi.mocked(fs.readFile).mockResolvedValue('/bin/bash\n/usr/local/bin/fish\n' as any);
                existing(['/usr/bin/zsh', '/bin/bash']);

                const names = (await EnvironmentService.detectShellPresets()).map(p => p.name);
                expect(names).toEqual(['zsh', 'bash']);
            });
        });
    });

    describe('isShellProcess', () => {
        it.each([
            ['/bin/zsh', 'zsh'],
            ['/bin/zsh', '/bin/zsh'],
            ['/bin/zsh', '-zsh'],
            ['/usr/local/bin/fish', 'fish'],
            ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'PWSH.EXE'],
        ])('should treat %s with foreground "%s" as an idle shell', (shell, fg) => {
            expect(EnvironmentService.isShellProcess(shell, fg)).toBe(true);
        });

        it.each([
            ['/bin/bash', 'claude'],
            ['/bin/bash', 'node'],
            ['/bin/bash', 'vim'],
            ['/bin/bash', 'python3'],
        ])('should treat %s with foreground "%s" as busy', (shell, fg) => {
            expect(EnvironmentService.isShellProcess(shell, fg)).toBe(false);
        });

        it('should treat an unknown foreground process (null/empty) as not safe', () => {
            expect(EnvironmentService.isShellProcess('/bin/bash', null)).toBe(false);
            expect(EnvironmentService.isShellProcess('/bin/bash', '')).toBe(false);
        });

        // macOS 的 node-pty 回報實際執行檔名稱 (p_comm)：設定的 shell 是指向其他名稱的 symlink 時要比對實際程式
        it('should recognise the real program behind a symlinked shell', () => {
            const realpath = (p: string) => (p === '/usr/local/bin/mysh' ? '/opt/homebrew/Cellar/zsh/5.9/bin/zsh' : p);

            expect(EnvironmentService.isShellProcess('/usr/local/bin/mysh', 'zsh', { realpath, platform: 'darwin' })).toBe(true);
            expect(EnvironmentService.isShellProcess('/usr/local/bin/mysh', 'mysh', { realpath, platform: 'darwin' })).toBe(true);
            expect(EnvironmentService.isShellProcess('/usr/local/bin/mysh', 'vim', { realpath, platform: 'darwin' })).toBe(false);
        });

        it('should follow a real symlink on disk', async () => {
            const realFs = await vi.importActual<typeof import('fs')>('fs');
            const realOs = await vi.importActual<typeof import('os')>('os');
            const nodePath = await vi.importActual<typeof import('path')>('path');
            const dir = realFs.mkdtempSync(nodePath.join(realOs.tmpdir(), 'agent-shell-'));
            try {
                realFs.writeFileSync(nodePath.join(dir, 'dash'), '');
                realFs.symlinkSync(nodePath.join(dir, 'dash'), nodePath.join(dir, 'sh'), 'file');

                expect(EnvironmentService.isShellProcess(nodePath.join(dir, 'sh'), 'dash')).toBe(true);
            } finally {
                realFs.rmSync(dir, { recursive: true, force: true });
            }
        });

        // macOS 的 /bin/sh 不是 symlink，而是依 /private/var/select/sh 執行 bash/dash/zsh 的啟動程式
        it('should recognise the shell that macOS /bin/sh launches', () => {
            const realpath = (p: string) => (p === '/private/var/select/sh' ? '/bin/dash' : p);

            expect(EnvironmentService.isShellProcess('/bin/sh', 'dash', { realpath, platform: 'darwin' })).toBe(true);
            expect(EnvironmentService.isShellProcess('/bin/sh', 'bash', { realpath, platform: 'darwin' })).toBe(false);
            // 其他平台不套用 macOS 的規則
            expect(EnvironmentService.isShellProcess('/bin/sh', 'dash', { realpath, platform: 'linux' })).toBe(false);
        });
    });

    describe('buildClearLineSequence', () => {
        it.each(['/bin/bash', '/bin/zsh', '/usr/bin/fish', 'C:\\Windows\\System32\\wsl.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'])(
            'should use Ctrl+E Ctrl+U for %s', (shell) => {
                expect(EnvironmentService.buildClearLineSequence(shell, 'win32')).toBe('\x05\x15');
            });

        it.each(['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'])(
            'should use Esc for %s on Windows', (shell) => {
                expect(EnvironmentService.buildClearLineSequence(shell, 'win32')).toBe('\x1b');
            });

        it('should use Ctrl+E Ctrl+U for PowerShell outside Windows (Emacs edit mode)', () => {
            expect(EnvironmentService.buildClearLineSequence('/usr/local/bin/pwsh', 'darwin')).toBe('\x05\x15');
        });
    });

    describe('buildCdCommand', () => {
        it.each(['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/bin/sh'])('should single-quote the path for POSIX shell %s', (shell) => {
            expect(EnvironmentService.buildCdCommand(shell, '/vault/My Notes')).toBe(`cd '/vault/My Notes'\r`);
        });

        it('should not let POSIX shells expand $ or backticks in folder names', () => {
            expect(EnvironmentService.buildCdCommand('/bin/bash', '/vault/$HOME `rm -rf ~`'))
                .toBe(`cd '/vault/$HOME \`rm -rf ~\`'\r`);
        });

        it('should escape single quotes for POSIX shells', () => {
            expect(EnvironmentService.buildCdCommand('/bin/zsh', "/vault/it's")).toBe(`cd '/vault/it'\\''s'\r`);
        });

        it.each(['C:\\Windows\\System32\\cmd.exe', 'C:\\WINDOWS\\SYSTEM32\\CMD.EXE', 'cmd'])('should use cd /d for %s', (shell) => {
            expect(EnvironmentService.buildCdCommand(shell, 'D:\\Vault\\Notes')).toBe(`cd /d "D:\\Vault\\Notes"\r`);
        });

        // cmd 在雙引號內仍會展開 %VAR%，且 ^ 在引號內是字面字元：每個 % 之後先關閉引號、以 ^ 跳脫下一個字元再重新開引號，
        // 變數名稱就一定以 " 開頭 (不存在)，互動模式下原樣保留；cd 會去掉路徑中的引號。已以實際 cmd.exe 驗證
        it.each([
            ['D:\\Vault\\%PATH%', 'cd /d "D:\\Vault\\%"^P"ATH%"\r'],
            ['D:\\a%x%PATH%b', 'cd /d "D:\\a%"^x"%"^P"ATH%"^b""\r'],
            ['D:\\p%%q', 'cd /d "D:\\p%"^%"q"\r'],
            ['D:\\end%', 'cd /d "D:\\end%"\r'],
            ['D:\\x %OS% & (y)', 'cd /d "D:\\x %"^O"S%"^ "& (y)"\r']
        ])('should keep cmd from expanding %%VAR%% in %s', (dir, expected) => {
            expect(EnvironmentService.buildCdCommand('C:\\Windows\\System32\\cmd.exe', dir)).toBe(expected);
        });

        describe('WSL (wsl.exe)', () => {
            const wsl = 'C:\\Windows\\System32\\wsl.exe';

            it.each([
                ['C:\\Users\\me\\My Vault', `cd '/mnt/c/Users/me/My Vault'\r`],
                ['D:\\Notes', `cd '/mnt/d/Notes'\r`],
                ['e:/Notes/sub', `cd '/mnt/e/Notes/sub'\r`],
                ['C:\\', `cd '/mnt/c/'\r`]
            ])('should translate the Windows path %s to the /mnt mount', (dir, expected) => {
                expect(EnvironmentService.buildCdCommand(wsl, dir)).toBe(expected);
            });

            it.each([
                ['\\\\wsl$\\Ubuntu\\home\\me\\vault', `cd '/home/me/vault'\r`],
                ['\\\\wsl.localhost\\Ubuntu-22.04\\home\\me', `cd '/home/me'\r`],
                ['\\\\wsl.localhost\\Ubuntu', `cd '/'\r`]
            ])('should translate the WSL share path %s to the Linux path', (dir, expected) => {
                expect(EnvironmentService.buildCdCommand(wsl, dir)).toBe(expected);
            });

            it('should still single-quote and escape the translated path', () => {
                expect(EnvironmentService.buildCdCommand('wsl', "C:\\it's $HOME")).toBe(`cd '/mnt/c/it'\\''s $HOME'\r`);
            });
        });

        it.each([
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
            '/usr/local/bin/pwsh'
        ])('should use Set-Location -LiteralPath with single quotes for %s', (shell) => {
            expect(EnvironmentService.buildCdCommand(shell, "D:\\Vault\\$it's"))
                .toBe(`Set-Location -LiteralPath 'D:\\Vault\\$it''s'\r`);
        });
    });
});
