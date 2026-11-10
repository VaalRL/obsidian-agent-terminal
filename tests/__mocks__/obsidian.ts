// obsidian 套件只提供型別定義 (main 為空)，測試時以此最小實作替代。
// 只放被測模組在執行期實際用到的類別。

export class FileSystemAdapter {
    constructor(private basePath: string = '') {}

    getBasePath(): string {
        return this.basePath;
    }
}

export class Notice {
    // 記錄所有顯示過的訊息，供測試斷言
    static messages: string[] = [];

    constructor(public message: string) {
        Notice.messages.push(message);
    }
}

// ContextService 以 instanceof TFolder 走訪資料夾
export class TFolder {
    path = '';
    children: unknown[] = [];
}

// 設定頁 (宣告式設定 API，Obsidian 1.13+)：update() 重新取得設定清單，refreshDomState() 只重新評估 visible/disabled
export class PluginSettingTab {
    settingItems: unknown[] = [];
    updateCount = 0;
    refreshCount = 0;

    constructor(public app: unknown, public plugin: unknown) {}

    getSettingDefinitions(): unknown[] {
        return [];
    }

    update(): void {
        this.updateCount++;
        this.settingItems = this.getSettingDefinitions();
    }

    refreshDomState(): void {
        this.refreshCount++;
    }

    hide(): void {}
}

// FolderSuggest 繼承此類別 (模組載入時就需要存在)
export class AbstractInputSuggest<T> {
    constructor(public app: unknown, public inputEl: unknown) {}
    getSuggestions(_query: string): T[] {
        return [];
    }
}

export const Platform = { isWin: false, isMacOS: false, isLinux: true, isDesktop: true };

export function requireApiVersion(_version: string): boolean {
    return true;
}

// Obsidian 的 API 版本 (ContextService 寫進 ai-core.md 的環境資訊)
export const apiVersion = '1.15.0';
