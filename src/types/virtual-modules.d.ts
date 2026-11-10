// 由 esbuild.config.mjs 的 bridgeSourcePlugin 在建置時產生：bridge.ts 打包後的程式碼字串
declare module 'virtual:bridge-source' {
    const source: string;
    export default source;
}

// 由 esbuild.config.mjs 的 nativeManifestPlugin 產生：node-pty 下載清單 (開發版建置為 null)
declare module 'virtual:native-manifest' {
    const manifest: import('../services/NativeInstaller').NativeManifest | null;
    export default manifest;
}
