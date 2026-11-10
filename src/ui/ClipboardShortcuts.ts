import type { Terminal } from 'xterm';

export type ShortcutPlatform = 'mac' | 'windows' | 'linux';

/**
 * - copy：複製選取文字
 * - copy-and-clear：複製後取消選取 (Ctrl+C 兼作中斷鍵，取消選取後下一次 Ctrl+C 才會送出中斷)
 * - paste：貼上剪貼簿內容
 */
export type ClipboardAction = 'copy' | 'copy-and-clear' | 'paste';

type KeyLike = Pick<KeyboardEvent, 'type' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

type ShortcutTerminal = Pick<Terminal, 'attachCustomKeyEventHandler' | 'hasSelection' | 'getSelection' | 'clearSelection' | 'paste'>;

interface ClipboardLike {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
}

/**
 * 依平台決定快捷鍵對應的剪貼簿動作 (參考 Windows Terminal 的慣例)；null 表示交給終端機處理。
 *
 * | 平台          | 複製                                         | 貼上                                   |
 * | ------------- | -------------------------------------------- | -------------------------------------- |
 * | Windows       | Ctrl+Shift+C、Ctrl+Insert、有選取時的 Ctrl+C | Ctrl+Shift+V、Shift+Insert、Ctrl+V     |
 * | Linux         | 同 Windows                                    | Ctrl+Shift+V、Shift+Insert (Ctrl+V 保留給 shell) |
 * | macOS         | 有選取時的 Cmd+C                              | Cmd+V                                  |
 */
export function getClipboardAction(event: KeyLike, platform: ShortcutPlatform, hasSelection: boolean): ClipboardAction | null {
    if (event.type !== 'keydown' || event.altKey) return null;
    const { ctrlKey: ctrl, shiftKey: shift, metaKey: meta, code } = event;

    if (platform === 'mac') {
        if (!meta || ctrl || shift) return null;
        if (code === 'KeyC') return hasSelection ? 'copy' : null;
        if (code === 'KeyV') return 'paste';
        return null;
    }

    if (meta) return null;
    if (ctrl && shift && code === 'KeyC') return 'copy';
    if (ctrl && shift && code === 'KeyV') return 'paste';
    if (ctrl && !shift && code === 'KeyC') return hasSelection ? 'copy-and-clear' : null;
    if (ctrl && !shift && code === 'Insert') return hasSelection ? 'copy' : null;
    if (shift && !ctrl && code === 'Insert') return 'paste';
    // Linux 終端機慣例中 Ctrl+V 是「下一個字元原樣輸入」(vim 的區塊選取)，只在 Windows 用來貼上
    if (platform === 'windows' && ctrl && !shift && code === 'KeyV') return 'paste';
    return null;
}

/**
 * 為 xterm 加上複製/貼上快捷鍵。
 * 會在 keydown 呼叫 preventDefault 阻止瀏覽器原生的複製/貼上，確保只貼上一次
 * (原本 Ctrl+Shift+V 會同時觸發手動貼上與 Chromium 的原生貼上，造成重複貼上)。
 */
export function attachClipboardShortcuts(terminal: ShortcutTerminal, platform: ShortcutPlatform, clipboard: ClipboardLike): void {
    terminal.attachCustomKeyEventHandler((event) => {
        const action = getClipboardAction(event, platform, terminal.hasSelection());
        if (!action) return true;

        event.preventDefault();
        if (action === 'paste') {
            clipboard.readText()
                .then((text) => { if (text) terminal.paste(text); })
                .catch(() => { /* 剪貼簿權限被拒 */ });
        } else {
            const selection = terminal.getSelection();
            if (selection) {
                void clipboard.writeText(selection).catch(() => { /* 剪貼簿權限被拒 */ });
                if (action === 'copy-and-clear') terminal.clearSelection();
            }
        }
        return false;
    });
}
