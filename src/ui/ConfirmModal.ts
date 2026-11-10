import { App, Modal, Setting } from 'obsidian';

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel: string;
    /** 列在說明下方的項目 (例如會被取代的檔案) */
    details?: string[];
    /** 確認鈕使用警告樣式 (mod-warning)；否則為主要動作樣式 (mod-cta) */
    destructive?: boolean;
}

export class ConfirmModal extends Modal {
    private confirmed = false;
    private onClosed: ((confirmed: boolean) => void) | null = null;

    constructor(app: App, private readonly options: ConfirmOptions) {
        super(app);
    }

    /**
     * 顯示確認視窗，回傳使用者是否按下確認。
     * 按取消、Esc 或關閉鈕都會回傳 false，promise 一定會結束。
     */
    static ask(app: App, options: ConfirmOptions): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmModal(app, options);
            modal.onClosed = resolve;
            modal.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        const { title, message, confirmLabel, details = [], destructive = false } = this.options;
        contentEl.empty();

        this.titleEl.setText(title);
        contentEl.createEl('p', { text: message });
        if (details.length > 0) {
            const list = contentEl.createEl('ul');
            for (const detail of details) list.createEl('li', { text: detail });
        }

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText('Cancel')
                    .onClick(() => {
                        this.close();
                    }))
            .addButton((btn) => {
                btn
                    .setButtonText(confirmLabel)
                    .onClick(() => {
                        this.confirmed = true;
                        this.close();
                    });
                btn.buttonEl.addClass(destructive ? 'mod-warning' : 'mod-cta');
            });
    }

    onClose() {
        this.contentEl.empty();
        this.onClosed?.(this.confirmed);
        this.onClosed = null;
    }
}
