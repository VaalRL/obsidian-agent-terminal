import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 由 vitest.config.ts 的 alias 導向 tests/__mocks__/obsidian.ts
import { FileSystemAdapter, TFolder } from 'obsidian';
import { BootstrapConfirmation, ContextService } from '../src/services/ContextService';
import { GENERATED_MARKER } from '../src/services/LinkService';

const folder = (p: string, children: unknown[] = []) => Object.assign(Object.create(TFolder.prototype), { path: p, children });

describe('ContextService', () => {
    it('generated instruction content should carry the marker LinkService uses to recognise its own files', () => {
        // 少了標記，重新初始化時會把外掛自己產生的 ai-core.md 當成使用者檔案而重複備份
        const content = ContextService.generateInstructionContent('My Vault', '## context');

        expect(content).toContain(GENERATED_MARKER);
    });

    it('getVaultContext should gather the vault structure synchronously (no useless async)', () => {
        const app = { vault: { getRoot: () => folder('', [folder('Projects', [folder('Projects/Alpha')])]) } } as never;

        const context = ContextService.getVaultContext(app);

        expect(typeof context).toBe('string');
        expect(context).toContain('- Projects/');
        expect(context).toContain('  - Projects/Alpha/');
    });

    it('should report the Obsidian version and which known plugins are enabled', () => {
        const app = (plugins: string[]) => ({
            vault: { getRoot: () => folder('') },
            plugins: { enabledPlugins: new Set(plugins) }
        }) as never;

        const withDataview = ContextService.getVaultContext(app(['dataview']));
        expect(withDataview).toContain('- Obsidian version: 1.15.0');
        expect(withDataview).toContain('- Dataview: enabled');
        expect(withDataview).toContain('- Templater: not enabled');
        expect(withDataview).not.toMatch(/, *\n/);

        expect(ContextService.getVaultContext(app([]))).toContain('- Dataview: not enabled');
    });

    // explore-vault 要 agent 更新這個區塊，ai-core.md 裡必須有它
    it('should include the Directory Definitions section that explore-vault updates', () => {
        const content = ContextService.generateInstructionContent('My Vault', '## context');
        const explore = ContextService.buildSkills('My Vault', '')['explore-vault'];

        expect(content).toMatch(/\n## Directory Definitions\n/);
        expect(explore).toContain('## Directory Definitions');
    });

    it('should not name a specific (possibly retired) AI tool in the shared instructions', () => {
        const content = ContextService.generateInstructionContent('My Vault', '## context');

        expect(content).not.toMatch(/Gemini/);
    });

    describe('buildSkills', () => {
        const skills = ContextService.buildSkills('My Vault', '## Vault Structure');

        it('should provide the default skills, and dataview-expert only when Dataview is enabled', () => {
            expect(Object.keys(skills).sort())
                .toEqual(['explore-vault', 'obsidian-cli', 'obsidian-master', 'vault-map']);
            expect(Object.keys(ContextService.buildSkills('My Vault', '', { dataview: true })).sort())
                .toEqual(['dataview-expert', 'explore-vault', 'obsidian-cli', 'obsidian-master', 'vault-map']);
        });

        it('vault-map should say it is a snapshot and how to see the current structure', () => {
            expect(skills['vault-map']).toMatch(/snapshot/i);
            expect(skills['vault-map']).toMatch(/current/i);
            expect(skills['vault-map']).toContain('Bootstrap AI core');
        });

        describe('obsidian-cli skill', () => {
            const cli = skills['obsidian-cli'];

            it('should open today\'s daily note with the official CLI', () => {
                expect(cli).toContain('obsidian daily');
            });

            it('should switch view modes through command IDs', () => {
                expect(cli).toContain('obsidian command id=markdown:toggle-preview');
                expect(cli).toContain('obsidian command id=editor:toggle-source');
            });

            it('should tell the agent to look up unknown command IDs instead of guessing', () => {
                expect(cli).toContain('obsidian commands');
            });

            it('should tell the agent how to react when the CLI is missing', () => {
                expect(cli).toMatch(/Command line interface/);
            });

            // Codex 預設在沙箱中執行指令，連到 Obsidian 的 CLI 可能被擋下
            it('should tell the agent to ask for approval when a sandbox blocks the CLI', () => {
                expect(cli).toMatch(/sandbox/i);
                expect(cli).toMatch(/outside the sandbox/);
            });

            it('should ask before destructive commands', () => {
                expect(cli).toMatch(/[Aa]sk the user before/);
            });

            it('should name the vault so the right window responds', () => {
                expect(cli).toContain('vault="My Vault"');
            });
        });

        it.each(Object.entries(ContextService.buildSkills('My Vault', '', { dataview: true })))(
            'skill %s should have SKILL.md frontmatter whose name matches its folder', (name, content) => {
                expect(content).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
            });

        it('explore-vault should refer to the vault-map skill instead of an old file path', () => {
            expect(skills['explore-vault']).not.toContain('vault-map.md');
            expect(skills['explore-vault']).toContain('vault-map');
        });

        // `/explore-vault` 是 Claude Code 的寫法；Codex、opencode 叫用 skill 的方式不同
        it('the instructions should not rely on the slash-command syntax of one agent', () => {
            const content = ContextService.generateInstructionContent('My Vault', '');
            expect(content).not.toContain('/explore-vault');
            expect(content).toContain('explore-vault');
        });

        it('explore-vault should not rely on tool names of a specific CLI', () => {
            expect(skills['explore-vault']).not.toMatch(/write_file/);
        });
    });
});

describe('ContextService.performBootstrap', () => {
    let vault: string;
    const v = (...p: string[]) => path.join(vault, ...p);
    const makeApp = (plugins: string[] = []) => ({
        vault: {
            adapter: new (FileSystemAdapter as unknown as new (base: string) => unknown)(vault),
            getName: () => 'My Vault',
            getRoot: () => folder('')
        },
        plugins: { enabledPlugins: new Set(plugins) }
    }) as never;

    beforeEach(() => {
        vault = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bootstrap-'));
    });

    afterEach(() => {
        fs.rmSync(vault, { recursive: true, force: true });
    });

    it('should bootstrap right away when nothing would be replaced', async () => {
        const confirm = vi.fn(async () => true);

        await ContextService.performBootstrap(makeApp(), confirm);

        expect(confirm).not.toHaveBeenCalled();
        expect(fs.readFileSync(v('CLAUDE.md'), 'utf8')).toContain(GENERATED_MARKER);
    });

    it('should ask first when the user\'s own files would be backed up, and do nothing when declined', async () => {
        fs.writeFileSync(v('CLAUDE.md'), 'my rules');
        const confirm = vi.fn(async (_request: BootstrapConfirmation) => false);

        await ContextService.performBootstrap(makeApp(), confirm);

        expect(confirm).toHaveBeenCalledTimes(1);
        const request = confirm.mock.calls[0][0];
        expect(request.details).toEqual([expect.stringContaining('CLAUDE.md')]);
        expect(request.confirmLabel).toBeTruthy();
        expect(fs.readFileSync(v('CLAUDE.md'), 'utf8')).toBe('my rules');
        expect(fs.existsSync(v('ai-core.md'))).toBe(false);
    });

    it('should back up and bootstrap once confirmed', async () => {
        fs.writeFileSync(v('CLAUDE.md'), 'my rules');

        await ContextService.performBootstrap(makeApp(), async () => true);

        expect(fs.readFileSync(v('CLAUDE.md.bak'), 'utf8')).toBe('my rules');
        expect(fs.readFileSync(v('CLAUDE.md'), 'utf8')).toContain(GENERATED_MARKER);
    });

    it('should ask before replacing an ai-core.md edited after it was generated (e.g. Directory Definitions)', async () => {
        await ContextService.performBootstrap(makeApp(), async () => true);
        fs.appendFileSync(v('ai-core.md'), '\n- Projects: active work\n');
        const confirm = vi.fn(async (_request: BootstrapConfirmation) => false);

        await ContextService.performBootstrap(makeApp(), confirm);

        expect(confirm.mock.calls[0][0].details).toEqual([expect.stringMatching(/^ai-core\.md.*edited/)]);
        expect(fs.readFileSync(v('ai-core.md'), 'utf8')).toContain('- Projects: active work');
    });

    it('should install dataview-expert only when Dataview is enabled', async () => {
        await ContextService.performBootstrap(makeApp(), async () => true);
        expect(fs.existsSync(v('.ai-core', 'skills', 'dataview-expert'))).toBe(false);

        await ContextService.performBootstrap(makeApp(['dataview']), async () => true);
        expect(fs.existsSync(v('.ai-core', 'skills', 'dataview-expert', 'SKILL.md'))).toBe(true);
    });
});
