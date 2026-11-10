import type { App } from 'obsidian';
import { FileSystemAdapter } from 'obsidian';
import { AgentTerminalSettings, CwdMode } from '../core/settings';
import * as path from 'path';

export class PathResolver {
    /**
     * 根據設定檔與當前 Obsidian 狀態，解析出終端機的啟動目錄 (絕對路徑)
     */
    static resolveCwd(app: App, settings: AgentTerminalSettings): string {
        // 確認 Adapter 是否具備 getBasePath 方法，取得本機絕對路徑；否則 fallback (非桌面環境)
        if (!(app.vault.adapter instanceof FileSystemAdapter)) {
            return process.cwd();
        }
        const basePath = app.vault.adapter.getBasePath();

        switch (settings.cwdMode) {
            case CwdMode.CurrentFile: {
                const activeFile = app.workspace.getActiveFile();
                if (activeFile && activeFile.parent) {
                    return path.join(basePath, activeFile.parent.path);
                }
                // fallback 到 VaultRoot
                return basePath;
            }

            case CwdMode.CustomPath:
                if (settings.customCwdPath && settings.customCwdPath.trim() !== '') {
                    // 若是絕對路徑則直接使用，若是相對路徑則相對於 basePath
                    return path.isAbsolute(settings.customCwdPath)
                        ? settings.customCwdPath
                        : path.join(basePath, settings.customCwdPath);
                }
                // fallback 到 VaultRoot
                return basePath;

            case CwdMode.VaultRoot:
            default:
                return basePath;
        }
    }
}

