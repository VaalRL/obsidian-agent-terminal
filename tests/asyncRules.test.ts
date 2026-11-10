import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// Obsidian 外掛規範 (claude/11 §2.2)：標了 async 的函式必須至少有一個 await，官方送審 lint 會擋
const SRC_DIR = path.join(__dirname, '..', 'src');
// 例外：覆寫基底類別的方法必須維持 Promise 回傳型別 (ItemView.onOpen / onClose)
const OVERRIDE_METHODS = new Set(['onOpen', 'onClose']);

function listTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listTsFiles(full);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
}

/** 函式本體 (不含巢狀函式) 是否有 await / for await */
function containsAwait(fn: ts.Node): boolean {
    let found = false;
    const visit = (node: ts.Node) => {
        if (found) return;
        if (node !== fn && ts.isFunctionLike(node)) return;
        if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    return found;
}

function findUselessAsync(file: string): string[] {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const offenders: string[] = [];
    const visit = (node: ts.Node) => {
        const isAsync = ts.canHaveModifiers(node)
            && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
        if (ts.isFunctionLike(node) && isAsync && !containsAwait(node)) {
            const name = 'name' in node && node.name ? node.name.getText(source) : '(anonymous)';
            if (!OVERRIDE_METHODS.has(name)) {
                const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
                offenders.push(`${path.relative(SRC_DIR, file)}:${line + 1}: ${name}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return offenders;
}

describe('No useless async (Obsidian plugin rules)', () => {
    it('should not mark a function async unless it awaits something', () => {
        expect(listTsFiles(SRC_DIR).flatMap(findUselessAsync)).toEqual([]);
    });
});
