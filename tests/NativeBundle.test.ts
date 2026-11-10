import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';

import { packageNative, mergeNative } from '../scripts/package-native.mjs';
import { decodeNativeBundle } from '../src/services/NativeBundle';
import { makeFakeNodePty } from './helpers/fakeNodePty';

const gz = (obj: unknown) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));

describe('native bundle packaging ↔ decoding', () => {
    let work: string;
    let src: string;
    let out: string;

    beforeEach(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-native-'));
        src = path.join(work, 'node-pty');
        out = path.join(work, 'out');
        makeFakeNodePty(src);
    });

    afterEach(() => {
        fs.rmSync(work, { recursive: true, force: true });
    });

    const pack = (targets: string[]) => packageNative({ src, out, targets });
    const decodeTarget = (target: string) => {
        const files = decodeNativeBundle(fs.readFileSync(path.join(out, `node-pty-${target}.json.gz`)));
        return Object.fromEntries(files.map(f => [f.path, f]));
    };

    it('should write one bundle per available target and a manifest with matching sha256', () => {
        const manifest = pack(['darwin-arm64', 'win32-x64', 'linux-x64', 'win32-arm64']);

        expect(manifest.nodePtyVersion).toBe('1.1.0');
        expect(Object.keys(manifest.assets).sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64']);
        for (const asset of Object.values(manifest.assets)) {
            const bytes = fs.readFileSync(path.join(out, asset.file));
            expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
            expect(asset.size).toBe(bytes.length);
        }
        expect(JSON.parse(fs.readFileSync(path.join(out, 'native-manifest.json'), 'utf8'))).toEqual(manifest);
    });

    it('should include lib, package.json and the platform binaries, but no tests, sourcemaps or debug symbols', () => {
        pack(['win32-x64']);
        const files = decodeTarget('win32-x64');

        expect(Object.keys(files).sort()).toEqual([
            'lib/index.js',
            'lib/worker/conoutSocketWorker.js',
            'package.json',
            'prebuilds/win32-x64/pty.node',
            'prebuilds/win32-x64/winpty-agent.exe'
        ]);
        expect(files['prebuilds/win32-x64/pty.node'].data.toString()).toBe('prebuilds/win32-x64/pty.node');
        expect(JSON.parse(files['package.json'].data.toString())).toEqual({ name: 'node-pty', version: '1.1.0', main: './lib/index.js' });
    });

    it('should mark spawn-helper as executable (macOS)', () => {
        pack(['darwin-arm64']);
        const files = decodeTarget('darwin-arm64');

        expect(files['prebuilds/darwin-arm64/spawn-helper'].mode).toBe(0o755);
        expect(files['prebuilds/darwin-arm64/pty.node'].mode).toBe(0o644);
    });

    it('should place the locally built Linux binary under prebuilds/linux-<arch>', () => {
        pack(['linux-x64']);
        const files = decodeTarget('linux-x64');

        expect(files['prebuilds/linux-x64/pty.node'].data.toString()).toBe('linux binary');
    });

    it('should merge manifests produced on different machines (CI)', () => {
        pack(['win32-x64']);
        const merged = pack(['darwin-arm64']);

        expect(Object.keys(merged.assets).sort()).toEqual(['darwin-arm64', 'win32-x64']);
    });

    describe('mergeNative (combine bundles built on different CI machines)', () => {
        it('should copy bundles from artifact folders and merge their manifests', () => {
            const x64 = path.join(work, 'artifact-x64');
            const arm = path.join(work, 'artifact-arm64');
            packageNative({ src, out: x64, targets: ['linux-x64'] });
            packageNative({ src, out: arm, targets: ['darwin-arm64'] });

            const merged = mergeNative({ out, from: [x64, arm] });

            expect(Object.keys(merged.assets).sort()).toEqual(['darwin-arm64', 'linux-x64']);
            expect(fs.existsSync(path.join(out, 'node-pty-linux-x64.json.gz'))).toBe(true);
            expect(fs.existsSync(path.join(out, 'node-pty-darwin-arm64.json.gz'))).toBe(true);
            // 之後再打包其他平台時會併入同一份 manifest
            expect(Object.keys(pack(['win32-x64']).assets).sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64']);
        });

        it('should refuse an artifact whose file does not match its manifest checksum', () => {
            const x64 = path.join(work, 'artifact-x64');
            packageNative({ src, out: x64, targets: ['linux-x64'] });
            fs.appendFileSync(path.join(x64, 'node-pty-linux-x64.json.gz'), 'tampered');

            expect(() => mergeNative({ out, from: [x64] })).toThrow(/checksum/i);
        });

        it('should refuse artifacts built from different node-pty versions', () => {
            const x64 = path.join(work, 'artifact-x64');
            packageNative({ src, out: x64, targets: ['linux-x64'] });
            pack(['win32-x64']);
            const manifestPath = path.join(out, 'native-manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), nodePtyVersion: '0.9.0' }));

            expect(() => mergeNative({ out, from: [x64] })).toThrow(/version/i);
        });
    });

    describe('decodeNativeBundle safety', () => {
        it.each(['../evil.js', '/etc/passwd', 'lib/../../evil.js', 'C:\\evil.js', 'lib\\..\\..\\evil.js', ''])(
            'should reject unsafe path %j', (bad) => {
                const bundle = gz({ format: 1, files: { [bad]: { data: '', mode: 0o644 } } });
                expect(() => decodeNativeBundle(bundle)).toThrow(/unsafe path/i);
            });

        it('should reject an unknown bundle format', () => {
            expect(() => decodeNativeBundle(gz({ format: 99, files: {} }))).toThrow(/format/i);
        });

        it('should reject data that is not a gzip bundle', () => {
            expect(() => decodeNativeBundle(Buffer.from('<html>Not Found</html>'))).toThrow();
        });

        it('should drop unexpected permission bits', () => {
            const files = decodeNativeBundle(gz({ format: 1, files: { 'lib/a.js': { data: '', mode: 0o4777 } } }));
            expect(files[0].mode).toBe(0o755);
        });
    });
});
