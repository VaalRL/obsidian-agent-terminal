// 將 node-pty 打包成各平台的下載檔 (node-pty-<platform>-<arch>.json.gz) 與 native-manifest.json。
// 外掛執行時依 manifest 下載對應平台的檔案並驗證 sha256 (見 src/services/NativeInstaller.ts)。
//
// 用法：node scripts/package-native.mjs [--src node_modules/node-pty] [--out dist/native] [--targets linux-x64,win32-x64]
//       node scripts/package-native.mjs --merge artifacts/a,artifacts/b [--out dist/native]   (合併 CI 各機器的結果)
//   - win32 / darwin：使用 node-pty 套件附帶的 prebuilds
//   - linux：node-pty 沒有附 prebuilds，使用本機 node-gyp 編譯出的 build/Release/pty.node (只能打包本機的 arch)
//
// 檔案格式需與 src/services/NativeBundle.ts 的 decodeNativeBundle 一致 (tests/NativeBundle.test.ts 會驗證)。

import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import { pathToFileURL } from "url";

export const BUNDLE_FORMAT = 1;

// 這些檔案需要執行權限 (npm 套件內的 spawn-helper 沒有 x 權限，macOS 會 posix_spawnp failed)
const EXECUTABLES = new Set(["spawn-helper"]);
// 不需要下載的檔案：除錯符號、測試、sourcemap；conpty/ 只在 useConptyDll 時使用，bridge 未啟用
const EXCLUDE = [/\.pdb$/, /\.test\.js$/, /\.map$/, /(^|\/)conpty\//];

function parseArgs(argv) {
  const args = { src: "node_modules/node-pty", out: "dist/native", targets: null, merge: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in args)) throw new Error(`Unknown option: ${argv[i]}`);
    args[key] = key === "targets" || key === "merge" ? argv[i + 1].split(",") : argv[i + 1];
  }
  return args;
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

const excluded = (rel) => EXCLUDE.some((re) => re.test(rel));

/** 回傳 { 目標路徑(相對於 node-pty 套件根目錄): 來源檔案絕對路徑 } */
function collectFiles(src, target) {
  const files = {};
  for (const rel of listFiles(path.join(src, "lib"))) {
    if (rel.endsWith(".js") && !excluded(rel)) files[`lib/${rel}`] = path.join(src, "lib", rel);
  }

  const [platform] = target.split("-");
  const prebuildDir = path.join(src, "prebuilds", target);
  if (platform === "linux") {
    const built = path.join(src, "build", "Release", "pty.node");
    if (!fs.existsSync(built)) return null;
    files[`prebuilds/${target}/pty.node`] = built;
  } else {
    const natives = listFiles(prebuildDir).filter((rel) => !excluded(rel));
    if (natives.length === 0) return null;
    for (const rel of natives) files[`prebuilds/${target}/${rel}`] = path.join(prebuildDir, rel);
  }
  return files;
}

export function encodeBundle(files, packageJson) {
  const entries = { "package.json": { data: Buffer.from(JSON.stringify(packageJson, null, 2)).toString("base64"), mode: 0o644 } };
  for (const [rel, source] of Object.entries(files)) {
    entries[rel] = {
      data: fs.readFileSync(source).toString("base64"),
      mode: EXECUTABLES.has(path.posix.basename(rel)) ? 0o755 : 0o644,
    };
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify({ format: BUNDLE_FORMAT, files: entries })), { level: 9 });
}

export function packageNative({ src, out, targets }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  const allTargets = targets ?? [
    "win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", `linux-${process.arch}`,
  ];

  fs.mkdirSync(out, { recursive: true });
  const manifest = { nodePtyVersion: pkg.version, assets: {} };

  for (const target of allTargets) {
    const files = collectFiles(src, target);
    if (!files) {
      console.warn(`[package-native] skip ${target}: no native binary found`);
      continue;
    }
    const bundle = encodeBundle(files, { name: "node-pty", version: pkg.version, main: pkg.main });
    const file = `node-pty-${target}.json.gz`;
    fs.writeFileSync(path.join(out, file), bundle);
    manifest.assets[target] = {
      file,
      sha256: crypto.createHash("sha256").update(bundle).digest("hex"),
      size: bundle.length,
    };
    console.log(`[package-native] ${file} (${(bundle.length / 1024).toFixed(0)} KB)`);
  }

  // 合併既有 manifest：CI 會在不同機器上分別打包 (例如 linux-arm64)，最後彙整
  const manifestPath = path.join(out, "native-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (previous.nodePtyVersion === manifest.nodePtyVersion) {
      manifest.assets = { ...previous.assets, ...manifest.assets };
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * 合併其他機器打包的結果 (CI 的 artifact 資料夾)：複製下載檔並併入 out 的 manifest。
 * 檔案 sha256 與來源 manifest 不符、或 node-pty 版本不一致時中止，避免發佈錯誤的檔案。
 */
export function mergeNative({ out, from }) {
  fs.mkdirSync(out, { recursive: true });
  const manifestPath = path.join(out, "native-manifest.json");
  let manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;

  for (const dir of from) {
    const source = JSON.parse(fs.readFileSync(path.join(dir, "native-manifest.json"), "utf8"));
    if (manifest && manifest.nodePtyVersion !== source.nodePtyVersion) {
      throw new Error(`node-pty version mismatch: ${dir} has ${source.nodePtyVersion}, expected ${manifest.nodePtyVersion}`);
    }
    manifest ??= { nodePtyVersion: source.nodePtyVersion, assets: {} };

    for (const [target, asset] of Object.entries(source.assets)) {
      const file = path.join(dir, asset.file);
      if (sha256(file) !== asset.sha256) throw new Error(`checksum mismatch for ${file}`);
      fs.copyFileSync(file, path.join(out, asset.file));
      manifest.assets[target] = asset;
      console.log(`[package-native] merged ${asset.file} from ${dir}`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.merge) {
    mergeNative({ out: args.out, from: args.merge });
  } else {
    packageNative(args);
  }
}
