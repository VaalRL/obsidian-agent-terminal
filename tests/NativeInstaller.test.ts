import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { packageNative } from '../scripts/package-native.mjs';
import { NativeInstaller, NativeManifest } from '../src/services/NativeInstaller';
import { makeFakeNodePty } from './helpers/fakeNodePty';

const RELEASE_URL = 'https://github.com/example/plugin/releases/download/0.2.0';
const TARGET = 'linux-x64';

describe('NativeInstaller', () => {
    let work: string;
    let pluginDir: string;
    let assetsDir: string;
    let manifest: NativeManifest;
    let download: Mock<[url: string], Promise<ArrayBuffer>>;
    let consent: Mock<[sizeBytes: number], Promise<boolean>>;

    const installedDir = () => path.join(pluginDir, 'node_modules', 'node-pty');
    const read = (rel: string) => fs.readFileSync(path.join(installedDir(), rel), 'utf8');

    /** 以假的 node-pty 產生真正的下載檔與 manifest */
    const buildRelease = (binaryContent: string) => {
        const src = path.join(work, `src-${binaryContent}`);
        makeFakeNodePty(src, binaryContent);
        return packageNative({ src, out: assetsDir, targets: [TARGET] }) as NativeManifest;
    };

    const installer = (overrides: Partial<ConstructorParameters<typeof NativeInstaller>[0]> = {}) =>
        new NativeInstaller({ pluginDir, manifest, releaseUrl: RELEASE_URL, download, platformKey: TARGET, ...overrides });

    beforeEach(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-installer-'));
        pluginDir = path.join(work, 'plugin');
        assetsDir = path.join(work, 'assets');
        fs.mkdirSync(pluginDir);
        manifest = buildRelease('v1');
        // 模擬從 GitHub release 下載：依網址檔名讀取 assetsDir 裡的檔案
        download = vi.fn(async (url: string) => {
            const bytes = fs.readFileSync(path.join(assetsDir, path.basename(url)));
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        });
        consent = vi.fn(async (_sizeBytes: number): Promise<boolean> => true);
    });

    afterEach(() => {
        fs.rmSync(work, { recursive: true, force: true });
    });

    it('should do nothing for development builds without a manifest', async () => {
        const result = await installer({ manifest: null }).ensureInstalled(consent);

        expect(result).toBe('ready');
        expect(consent).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
    });

    it('should report unsupported platforms without asking or downloading', async () => {
        const result = await installer({ platformKey: 'freebsd-x64' }).ensureInstalled(consent);

        expect(result).toBe('unsupported');
        expect(consent).not.toHaveBeenCalled();
    });

    it('should not download anything when the user declines', async () => {
        consent.mockResolvedValue(false);

        const result = await installer().ensureInstalled(consent);

        expect(result).toBe('declined');
        expect(consent).toHaveBeenCalledWith(manifest.assets[TARGET].size);
        expect(download).not.toHaveBeenCalled();
        expect(fs.existsSync(installedDir())).toBe(false);
    });

    it('should download from the release, verify and install node-pty', async () => {
        const result = await installer().ensureInstalled(consent);

        expect(result).toBe('ready');
        expect(download).toHaveBeenCalledWith(`${RELEASE_URL}/node-pty-${TARGET}.json.gz`);
        expect(read('prebuilds/linux-x64/pty.node')).toBe('linux v1');
        expect(read('lib/index.js')).toBe('lib/index.js');
        expect(JSON.parse(read('package.json')).name).toBe('node-pty');
        expect(installer().status()).toBe('installed');
    });

    it('should set executable permission from the bundle', async () => {
        const src = path.join(work, 'src-mac');
        makeFakeNodePty(src);
        manifest = packageNative({ src, out: assetsDir, targets: ['darwin-arm64'] }) as NativeManifest;

        await installer({ platformKey: 'darwin-arm64' }).ensureInstalled(consent);

        const helper = path.join(installedDir(), 'prebuilds/darwin-arm64/spawn-helper');
        expect(fs.existsSync(helper)).toBe(true);
        // Windows 檔案系統沒有 POSIX 執行權限位 (stat().mode 不反映 chmod 設的 x 位)，只能在 POSIX 平台斷言
        if (process.platform !== 'win32') {
            expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
        }
    });

    it('should respect a node-pty the user installed manually (npm install, no marker)', async () => {
        fs.mkdirSync(installedDir(), { recursive: true });
        fs.writeFileSync(path.join(installedDir(), 'package.json'), '{"name":"node-pty"}');

        await expect(installer().ensureInstalled(consent)).resolves.toBe('ready');
        expect(consent).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
        expect(read('package.json')).toBe('{"name":"node-pty"}');
    });

    it('should not ask or download again once installed', async () => {
        await installer().ensureInstalled(consent);
        consent.mockClear();
        download.mockClear();

        await expect(installer().ensureInstalled(consent)).resolves.toBe('ready');
        expect(consent).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
    });

    it('should replace an older installation after a plugin update', async () => {
        await installer().ensureInstalled(consent);
        fs.writeFileSync(path.join(installedDir(), 'stale-file.txt'), 'old');
        manifest = buildRelease('v2');

        expect(installer().status()).toBe('missing');
        await installer().ensureInstalled(consent);

        expect(read('prebuilds/linux-x64/pty.node')).toBe('linux v2');
        expect(fs.existsSync(path.join(installedDir(), 'stale-file.txt'))).toBe(false);
    });

    it('should reject a download whose checksum does not match and keep the old installation', async () => {
        await installer().ensureInstalled(consent);
        manifest = { ...manifest, assets: { [TARGET]: { ...manifest.assets[TARGET], sha256: '0'.repeat(64) } } };

        await expect(installer().ensureInstalled(consent)).rejects.toThrow(/verification/i);

        expect(read('prebuilds/linux-x64/pty.node')).toBe('linux v1');
        expect(fs.readdirSync(path.join(pluginDir, 'node_modules'))).toEqual(['node-pty']);
    });

    it('should report a readable error when the download fails and leave no partial files', async () => {
        download.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));

        await expect(installer().ensureInstalled(consent)).rejects.toThrow(/download.*ERR_INTERNET_DISCONNECTED/i);

        expect(fs.existsSync(installedDir())).toBe(false);
        const leftovers = fs.existsSync(path.join(pluginDir, 'node_modules')) ? fs.readdirSync(path.join(pluginDir, 'node_modules')) : [];
        expect(leftovers).toEqual([]);
    });

    it('should share one consent prompt and one download between terminals opened at the same time', async () => {
        const shared = installer();

        const results = await Promise.all([shared.ensureInstalled(consent), shared.ensureInstalled(consent)]);

        expect(results).toEqual(['ready', 'ready']);
        expect(consent).toHaveBeenCalledTimes(1);
        expect(download).toHaveBeenCalledTimes(1);
    });
});
