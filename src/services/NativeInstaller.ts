import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { decodeNativeBundle } from './NativeBundle';

/** 由 scripts/package-native.mjs 產生、建置時內嵌於 main.js 的下載清單 */
export interface NativeManifest {
    nodePtyVersion: string;
    assets: Record<string, { file: string; sha256: string; size: number }>;
}

export type Downloader = (url: string) => Promise<ArrayBuffer>;

/** 詢問使用者是否同意下載 (參數為下載大小，bytes) */
export type ConsentPrompt = (sizeBytes: number) => Promise<boolean>;

export type InstallStatus = 'unmanaged' | 'unsupported' | 'installed' | 'missing';
export type InstallResult = 'ready' | 'declined' | 'unsupported';

export interface NativeInstallerOptions {
    pluginDir: string;
    /** null：開發版建置 (沒有打包原生檔)，不自動安裝，由開發者自行 npm install */
    manifest: NativeManifest | null;
    /** 下載檔所在的 GitHub release 網址 (不含檔名) */
    releaseUrl: string;
    download: Downloader;
    platformKey?: string;
}

const MARKER_FILE = '.agent-terminal-install.json';

/**
 * 負責把 node-pty 原生模組安裝到 <外掛資料夾>/node_modules/node-pty。
 * 社群外掛商店只安裝 main.js 等三個檔案，原生模組需在第一次使用時下載 (需使用者同意)。
 */
export class NativeInstaller {
    private readonly options: NativeInstallerOptions;
    private readonly platformKey: string;
    // 同時開啟多個終端機時共用同一次詢問與下載
    private pending: Promise<InstallResult> | null = null;

    constructor(options: NativeInstallerOptions) {
        this.options = options;
        this.platformKey = options.platformKey ?? `${process.platform}-${process.arch}`;
    }

    private get nodeModulesDir(): string {
        return path.join(this.options.pluginDir, 'node_modules');
    }

    private get installDir(): string {
        return path.join(this.nodeModulesDir, 'node-pty');
    }

    private get asset() {
        return this.options.manifest?.assets[this.platformKey] ?? null;
    }

    status(): InstallStatus {
        if (!this.options.manifest) return 'unmanaged';
        const asset = this.asset;
        if (!asset) return 'unsupported';
        const markerPath = path.join(this.installDir, MARKER_FILE);
        if (!fs.existsSync(markerPath)) {
            // 有 node-pty 但沒有標記：使用者自行 npm install 的，尊重它，不覆蓋
            return fs.existsSync(this.installDir) ? 'installed' : 'missing';
        }
        try {
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { sha256?: unknown };
            return marker.sha256 === asset.sha256 ? 'installed' : 'missing';
        } catch {
            return 'missing';
        }
    }

    /**
     * 確保 node-pty 已安裝；需要下載時先詢問使用者。失敗時丟出可讀的錯誤。
     */
    ensureInstalled(askConsent: ConsentPrompt): Promise<InstallResult> {
        if (!this.pending) {
            this.pending = this.run(askConsent).finally(() => { this.pending = null; });
        }
        return this.pending;
    }

    private async run(askConsent: ConsentPrompt): Promise<InstallResult> {
        const status = this.status();
        if (status === 'unmanaged' || status === 'installed') return 'ready';
        if (status === 'unsupported') return 'unsupported';

        const asset = this.asset!;
        if (!(await askConsent(asset.size))) return 'declined';

        const url = `${this.options.releaseUrl}/${asset.file}`;
        let bytes: Buffer;
        try {
            bytes = Buffer.from(await this.options.download(url));
        } catch (error) {
            throw new Error(`Failed to download the terminal engine from ${url}: ${(error as Error).message}`, { cause: error });
        }

        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== asset.sha256) {
            throw new Error('The downloaded terminal engine failed verification (checksum mismatch). Please try again later.');
        }

        this.install(bytes, asset.sha256);
        return 'ready';
    }

    /** 先完整寫到暫存資料夾，再整個換上，避免中途失敗留下半套檔案 */
    private install(bytes: Buffer, sha256: string): void {
        const files = decodeNativeBundle(bytes);
        const stamp = `${process.pid}-${Date.now()}`;
        const tempDir = path.join(this.nodeModulesDir, `.node-pty-install-${stamp}`);
        const oldDir = path.join(this.nodeModulesDir, `.node-pty-old-${stamp}`);

        try {
            for (const file of files) {
                const target = path.join(tempDir, ...file.path.split('/'));
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, file.data);
                fs.chmodSync(target, file.mode);
            }
            fs.writeFileSync(path.join(tempDir, MARKER_FILE), JSON.stringify({ sha256 }));

            if (fs.existsSync(this.installDir)) fs.renameSync(this.installDir, oldDir);
            fs.renameSync(tempDir, this.installDir);
        } catch (error) {
            // 還原舊版本
            if (!fs.existsSync(this.installDir) && fs.existsSync(oldDir)) fs.renameSync(oldDir, this.installDir);
            throw new Error(
                `Failed to install the terminal engine: ${(error as Error).message}. `
                + 'If other terminals are open, close them and try again.',
                { cause: error }
            );
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
            fs.rmSync(oldDir, { recursive: true, force: true });
            // 沒有安裝任何東西時，不留下空的 node_modules
            try { fs.rmdirSync(this.nodeModulesDir); } catch { /* 不是空的 */ }
        }
    }
}
