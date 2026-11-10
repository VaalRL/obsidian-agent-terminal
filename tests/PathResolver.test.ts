import { describe, it, expect, vi } from 'vitest';
// 由 vitest.config.ts 的 alias 導向 tests/__mocks__/obsidian.ts
import { FileSystemAdapter } from 'obsidian';

import { PathResolver } from '../src/services/PathResolver';
import { CwdMode, AgentTerminalSettings, DEFAULT_SETTINGS } from '../src/core/settings';
import * as path from 'path';

describe('PathResolver', () => {
    const mockApp = {
        vault: {
            adapter: new (FileSystemAdapter as any)('/mock/vault/root')
        },
        workspace: {
            getActiveFile: vi.fn()
        }
    } as any;

    const baseSettings: AgentTerminalSettings = {
        ...DEFAULT_SETTINGS,
        shellPath: '',
        cwdMode: CwdMode.VaultRoot,
        customCwdPath: '',
        autoSyncCwd: false
    };

    it('should resolve to VaultRoot', () => {
        const settings = { ...baseSettings, cwdMode: CwdMode.VaultRoot };
        const result = PathResolver.resolveCwd(mockApp, settings);
        expect(result).toBe('/mock/vault/root');
    });

    it('should resolve to CurrentFile directory', () => {
        mockApp.workspace.getActiveFile.mockReturnValueOnce({
            parent: { path: 'folder1/folder2' }
        });
        const settings = { ...baseSettings, cwdMode: CwdMode.CurrentFile };
        
        const result = PathResolver.resolveCwd(mockApp, settings);
        expect(result).toBe(path.join('/mock/vault/root', 'folder1/folder2'));
    });

    it('should fallback to VaultRoot if CurrentFile has no active file', () => {
        mockApp.workspace.getActiveFile.mockReturnValueOnce(null);
        const settings = { ...baseSettings, cwdMode: CwdMode.CurrentFile };
        
        const result = PathResolver.resolveCwd(mockApp, settings);
        expect(result).toBe('/mock/vault/root');
    });

    it('should resolve absolute CustomPath', () => {
        const customPath = osIsWin() ? 'C:\\my\\custom\\path' : '/my/custom/path';
        const settings = { ...baseSettings, cwdMode: CwdMode.CustomPath, customCwdPath: customPath };
        
        const result = PathResolver.resolveCwd(mockApp, settings);
        expect(result).toBe(customPath);
    });

    it('should resolve relative CustomPath based on VaultRoot', () => {
        const settings = { ...baseSettings, cwdMode: CwdMode.CustomPath, customCwdPath: 'relative/path' };
        
        const result = PathResolver.resolveCwd(mockApp, settings);
        expect(result).toBe(path.join('/mock/vault/root', 'relative/path'));
    });

    it('should fallback to process.cwd() when adapter is not a FileSystemAdapter', () => {
        const nonDesktopApp = { ...mockApp, vault: { adapter: {} } };

        const result = PathResolver.resolveCwd(nonDesktopApp, baseSettings);
        expect(result).toBe(process.cwd());
    });
});

function osIsWin() {
    return process.platform === 'win32';
}
