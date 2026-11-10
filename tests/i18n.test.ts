import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// 介面文字一律使用英文 (Task 6.1)；程式碼註解可以使用中文
const SRC_DIR = path.join(__dirname, '..', 'src');
const CJK = /[一-鿿　-〿＀-￯]/;

function listTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listTsFiles(full);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
}

/** 去掉註解後，回傳仍含中日韓文字的行 (即使用者可能看到的字串) */
function findNonEnglishStrings(file: string): string[] {
    const source = fs.readFileSync(file, 'utf8')
        // 區塊註解換成等量空行，保留行號
        .replace(/\/\*[\s\S]*?\*\//g, (block) => '\n'.repeat(block.split('\n').length - 1));

    // 以 \r?\n 分行：Windows 上 git core.autocrlf=true 會把檔案轉成 CRLF，
    // 只用 \n 分行會在行尾留下 \r，使下方剝除 // 註解的 .*$ 失效而把中文註解誤判為 UI 文字
    return source.split(/\r?\n/).flatMap((line, index) => {
        const code = line.replace(/(^|\s)\/\/.*$/, '');
        return CJK.test(code) ? [`${path.relative(SRC_DIR, file)}:${index + 1}: ${line.trim()}`] : [];
    });
}

describe('English UI (Task 6.1)', () => {
    it('should not contain non-English text outside of code comments', () => {
        const offenders = listTsFiles(SRC_DIR).flatMap(findNonEnglishStrings);

        expect(offenders).toEqual([]);
    });
});
