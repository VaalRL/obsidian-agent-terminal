import { App, AbstractInputSuggest, TFolder } from 'obsidian';

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
    protected textInputEl: HTMLInputElement;

    constructor(app: App, textInputEl: HTMLInputElement) {
        super(app, textInputEl);
        this.textInputEl = textInputEl;
    }

    getSuggestions(query: string): TFolder[] {
        const lowerCaseInputStr = query.toLowerCase();

        // Get all loaded files, filter for folders
        const allFiles = this.app.vault.getAllLoadedFiles();
        const folders: TFolder[] = [];

        for (const file of allFiles) {
            if (file instanceof TFolder) {
                if (file.path.toLowerCase().contains(lowerCaseInputStr)) {
                    folders.push(file);
                }
            }
        }

        return folders;
    }

    renderSuggestion(file: TFolder, el: HTMLElement): void {
        el.setText(file.path);
    }

    selectSuggestion(file: TFolder): void {
        this.textInputEl.value = file.path;
        this.textInputEl.trigger('input');
        this.close();
    }
}
