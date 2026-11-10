import { App, TFolder, apiVersion } from 'obsidian';
import { BootstrapChange, LinkService, GENERATED_MARKER } from './LinkService';

interface ObsidianAppInternals {
    plugins?: { enabledPlugins: Set<string> };
}

/** Bootstrap 會取代檔案時，請使用者確認的內容 (由 UI 以確認視窗顯示) */
export interface BootstrapConfirmation {
    title: string;
    message: string;
    details: string[];
    confirmLabel: string;
}

export type ConfirmBootstrap = (request: BootstrapConfirmation) => Promise<boolean>;

export class ContextService {
    /**
     * Gathers facts about the Vault structure
     */
    static getVaultContext(app: App): string {
        const folders: string[] = [];
        const root = app.vault.getRoot();
        
        // Traverse 1st and 2nd level directories
        for (const child of root.children) {
            if (child instanceof TFolder) {
                folders.push(`- ${child.path}/`);
                for (const subChild of child.children) {
                    if (subChild instanceof TFolder) {
                        folders.push(`  - ${subChild.path}/`);
                    }
                }
            }
        }

        const enabled = (id: string) => this.isPluginEnabled(app, id) ? 'enabled' : 'not enabled';

        return `
## 📂 Vault Structure
${folders.join('\n')}

## 🛠️ Environment Facts
- Obsidian version: ${apiVersion}
- Dataview: ${enabled('dataview')}
- Templater: ${enabled('templater')}
`;
    }

    /** 社群外掛是否已啟用 (Obsidian 沒有公開 API，取不到時視為未啟用) */
    static isPluginEnabled(app: App, id: string): boolean {
        return (app as unknown as ObsidianAppInternals).plugins?.enabledPlugins.has(id) ?? false;
    }

    /**
     * Generates the main instruction content for ai-core.md
     */
    static generateInstructionContent(vaultName: string, context: string): string {
        return `# 🧠 Agent Terminal: AI Instruction Core
This file is the single source of truth for every AI coding agent operating in this vault (for example Claude Code, Antigravity CLI, Codex CLI, opencode or Cursor).

## 👤 Persona
You are an expert knowledge management assistant for the Obsidian vault: **${vaultName}**. 
Your goal is to help the user organize, connect, and synthesize knowledge while strictly adhering to the vault's structure and rules.

${context}

## Directory Definitions
_Not documented yet._ Use the \`explore-vault\` skill to describe what each folder is for, and keep this list up to date.

## 📜 Behavior & Formatting Rules
1. **Internal Links**: ALWAYS use Obsidian Wikilinks: \`[[Note Name]]\`.
2. **Organization**: Follow the existing directory structure. Do not create new top-level folders unless asked.
3. **Metadata**: New notes should include YAML frontmatter with \`date\` and \`tags\`.
4. **Tags**: Use \`#tag\` format within the content or YAML.

## 🚀 Recommended Start
If this is your first time in this vault, use the \`explore-vault\` skill to understand the environment and establish directory definitions.

## 🛡️ Safety & Privacy
- DO NOT read or index folders marked as "Private" or "Confidential".
- DO NOT delete any \`.md\` files without explicit confirmation.

---
*${GENERATED_MARKER}*
`;
    }

    /**
     * Generates the vault-map skill content
     */
    static generateVaultMap(context: string): string {
        return `---
name: vault-map
description: A snapshot of this vault's folder structure, taken when Bootstrap AI core was last run.
---

# 🗺️ Vault Map (Snapshot)
The folder structure (two levels deep) when **Bootstrap AI core** was last run:

${context}

## 💡 Usage
- Use this map for a quick overview of how the vault is organized.
- It is a snapshot and does not change by itself. Before you rely on a folder, or when the user mentions one that is missing here, list the current folders yourself (for example \`ls\`, or \`Get-ChildItem\` in PowerShell).
- To refresh it, the user can run **Bootstrap AI core** again.
`;
    }

    /**
     * Generates the dataview-expert skill content
     */
    static generateDataviewSkill(): string {
        return `---
name: dataview-expert
description: Assistant for writing Dataview Query Language (DQL) or DataviewJS.
---

# 📊 Dataview Expert Skill
You are an expert in the Dataview plugin syntax.

## 🛠️ Tasks
1. **DQL Writing**: Assist users in creating \`LIST\`, \`TABLE\`, and \`TASK\` queries.
2. **Automation**: Generate index pages automatically based on tags or paths.
3. **Debugging**: Fix common syntax errors in Dataview queries.

## 📝 Example
\`\`\`dataview
TABLE date, tags
FROM "03_Projects"
WHERE !completed
SORT date DESC
\`\`\`
`;
    }

    /**
     * Generates the explore-vault skill content
     */
    static generateExplorerSkill(vaultName: string): string {
        return `---
name: explore-vault
description: Guides the AI to proactively interpret the purpose of each part of the Vault and document findings back to ai-core.md.
---

# 🔍 Explore Vault Skill
You assist the user in clarifying the organization of this Obsidian vault and establishing persistent documentation.

## 🛠️ Action Plan
1. **Read Map**: Use the \`vault-map\` skill for the directory list.
2. **Analyze Purpose**: Guess the responsibility of each major folder based on names and existing README files.
3. **Clarify**: Ask the user for clarification if a folder's purpose is ambiguous.
4. **Self-Document**: Summarize the "Directory Definitions" into a list and update the ## Directory Definitions section in \`ai-core.md\` with your file editing tools.

## 📝 How to start
Ask the agent to use the explore-vault skill (in Claude Code you can also type \`/explore-vault\`, in Codex CLI \`$explore-vault\`).
`;
    }

    /**
     * Generates the obsidian-master skill content
     */
    static generateMasterSkill(): string {
        return `---
name: obsidian-master
description: Best practices for Obsidian syntax, linking, callouts, and Canvas.
---

# 💎 Obsidian Mastery Skill
You are a master of Obsidian-specific syntax.

## 📐 Formatting Rules
- **Wikilinks**: ALWAYS use \`[[Note Name]]\`.
- **Callouts**: Use \`> [!info]\`, \`> [!todo]\`, \`> [!summary]\` effectively.
- **Canvas**: Understand that \`.canvas\` files are JSON-based visual maps.
- **Properties**: Ensure YAML frontmatter is correctly formatted.

## 🧠 Associative Thinking
- Every time you create a note, suggest 3 related notes from the vault in a \`## Links\` section.
`;
    }

    /**
     * Generates the obsidian-cli skill content: lets agents control the running Obsidian app
     * through the official Obsidian CLI (Obsidian 1.12.4+)
     */
    static generateObsidianCliSkill(vaultName: string): string {
        const vault = vaultName.replace(/"/g, '\\"');
        return `---
name: obsidian-cli
description: Control the Obsidian app the user is looking at with the official Obsidian CLI - open today's daily note, switch between reading and editing view, or run any command palette command.
---

# 🖥️ Obsidian CLI Skill
Use the \`obsidian\` command to act on the Obsidian window of the vault **${vaultName}**. Obsidian must be running (it is, when you were started from Agent Terminal).

## ✅ Before you start
Check that the command exists: \`command -v obsidian\` (PowerShell: \`Get-Command obsidian\`, cmd: \`where obsidian\`).
If it is missing, do not try to work around it. Tell the user to enable it in **Obsidian → Settings → General → Command line interface** (Obsidian 1.12.4 or later), then restart the terminal.

## 📅 Open today's daily note
\`\`\`
obsidian daily vault="${vault}"
\`\`\`
This needs the core *Daily notes* plugin to be enabled.

## 👁️ Switch the view mode of the active note
- Toggle reading view ↔ editing view: \`obsidian command id=markdown:toggle-preview vault="${vault}"\`
- Toggle Live Preview ↔ Source mode: \`obsidian command id=editor:toggle-source vault="${vault}"\`

## 🔍 Any other command
- List command IDs: \`obsidian commands vault="${vault}"\` (narrow it down with \`filter=<prefix>\`, e.g. \`filter=daily\`)
- Run one: \`obsidian command id=<command-id> vault="${vault}"\`
If an ID above does not work in this vault, look it up with \`obsidian commands\` instead of guessing.

## 🧱 Sandboxes
The CLI talks to the running Obsidian app. If your commands run in a sandbox (for example Codex CLI) and \`obsidian\` fails with a permission or connection error although it exists, ask the user to approve running it outside the sandbox instead of trying workarounds.

## 🛡️ Safety
- Ask the user before running commands that delete, move, rename or overwrite notes, or that change settings or plugins.
- Run one command at a time and tell the user what you ran.
`;
    }

    /**
     * 預設 skills：名稱 (= 資料夾名稱，需與 SKILL.md frontmatter 的 name 相同) → SKILL.md 內容
     */
    static buildSkills(vaultName: string, context: string, options: { dataview?: boolean } = {}): Record<string, string> {
        return {
            'explore-vault': this.generateExplorerSkill(vaultName),
            'obsidian-master': this.generateMasterSkill(),
            'vault-map': this.generateVaultMap(context),
            // 沒有啟用 Dataview 時，agent 寫出的查詢不會有作用
            ...(options.dataview ? { 'dataview-expert': this.generateDataviewSkill() } : {}),
            'obsidian-cli': this.generateObsidianCliSkill(vaultName)
        };
    }

    /**
     * Single orchestration point for the AI core bootstrap.
     * Called from both the command palette and the TerminalView button.
     * 會取代使用者的檔案或被編輯過的檔案 (改名或複製成 .bak) 時，先以 confirm 詢問；沒有時直接執行。
     */
    static async performBootstrap(app: App, confirm: ConfirmBootstrap): Promise<void> {
        const context = this.getVaultContext(app);
        const vaultName = app.vault.getName();
        const mainContent = this.generateInstructionContent(vaultName, context);
        const skills = this.buildSkills(vaultName, context, { dataview: this.isPluginEnabled(app, 'dataview') });

        const changes = LinkService.prepareBootstrap(app, mainContent, skills);
        if (changes.length > 0 && !(await confirm(this.describeChanges(changes)))) return;
        LinkService.bootstrapUnifiedCore(app, mainContent, skills);
    }

    static describeChanges(changes: BootstrapChange[]): BootstrapConfirmation {
        const explain = (change: BootstrapChange) => {
            if (change.reason === 'yours') return `${change.path}: your own file`;
            return change.path.endsWith('ai-core.md')
                ? `${change.path}: edited since it was generated (for example directory definitions written by explore-vault)`
                : `${change.path}: edited since it was generated`;
        };
        return {
            title: 'Bootstrap AI core',
            message: 'These files will be replaced. Each one is kept next to the original as a .bak copy, '
                + 'so you can merge what you need afterwards.',
            details: changes.map(explain),
            confirmLabel: 'Back up and continue'
        };
    }
}
