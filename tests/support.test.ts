import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BMC_URL } from '../src/core/constants';

// 贊助連結 (Buy Me a Coffee) 的單一真實來源是 src/core/constants.ts；
// manifest.json 的 fundingUrl 與 README 的徽章必須與它一致，作者欄位則是 GitHub 帳號 (不是贊助帳號)
const ROOT = path.join(__dirname, '..');
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as Record<string, unknown>;

describe('Support link and author identity', () => {
    it('should use the canonical Buy Me a Coffee URL', () => {
        expect(BMC_URL).toBe('https://www.buymeacoffee.com/whoami885');
    });

    it('should point manifest.json fundingUrl at the support link', () => {
        expect(readJson('manifest.json').fundingUrl).toBe(BMC_URL);
    });

    it('should link the support page from the README', () => {
        expect(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')).toContain(`(${BMC_URL})`);
    });

    it('should attribute the plugin to the GitHub account', () => {
        const manifest = readJson('manifest.json');
        expect(manifest.author).toBe('VaalRL');
        expect(manifest.authorUrl).toBe('https://github.com/VaalRL');
        expect(readJson('package.json').author).toBe('VaalRL');
        expect(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')).toMatch(/Copyright \(c\) \d{4} VaalRL/);
    });
});
