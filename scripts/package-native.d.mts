// package-native.mjs 的型別宣告 (供 tests/NativeBundle.test.ts 使用)
export interface NativeAssetInfo {
    file: string;
    sha256: string;
    size: number;
}

export interface PackagedManifest {
    nodePtyVersion: string;
    assets: Record<string, NativeAssetInfo>;
}

export const BUNDLE_FORMAT: number;

export function packageNative(options: { src: string; out: string; targets: string[] | null }): PackagedManifest;

export function mergeNative(options: { out: string; from: string[] }): PackagedManifest;
