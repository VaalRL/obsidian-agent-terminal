import * as zlib from 'zlib';

/**
 * node-pty 下載檔的格式：gzip 壓縮的 JSON { format, files: { 相對路徑: { data(base64), mode } } }。
 * 由 scripts/package-native.mjs 產生；兩邊的格式由 tests/NativeBundle.test.ts 一起驗證。
 */
export const BUNDLE_FORMAT = 1;

export interface BundleFile {
    path: string; // 相對於 node-pty 套件根目錄，一律使用 "/"
    data: Buffer;
    mode: number;
}

interface RawBundle {
    format?: unknown;
    files?: Record<string, { data?: unknown; mode?: unknown }>;
}

/** 只允許 "a/b/c" 形式的相對路徑，避免寫出目標資料夾之外 (zip-slip) */
function isSafeRelativePath(p: string): boolean {
    if (!p || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
    return p.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export function decodeNativeBundle(buffer: Buffer): BundleFile[] {
    const raw = JSON.parse(zlib.gunzipSync(buffer).toString('utf8')) as RawBundle;
    if (raw.format !== BUNDLE_FORMAT || typeof raw.files !== 'object' || raw.files === null) {
        throw new Error(`Unsupported terminal engine bundle format: ${String(raw.format)}`);
    }

    return Object.entries(raw.files).map(([filePath, entry]) => {
        if (!isSafeRelativePath(filePath)) {
            throw new Error(`Terminal engine bundle contains an unsafe path: ${JSON.stringify(filePath)}`);
        }
        const mode = typeof entry.mode === 'number' && (entry.mode & 0o111) ? 0o755 : 0o644;
        return { path: filePath, data: Buffer.from(typeof entry.data === 'string' ? entry.data : '', 'base64'), mode };
    });
}
