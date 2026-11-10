import { describe, it, expect, vi } from 'vitest';

import { getClipboardAction, attachClipboardShortcuts, ShortcutPlatform } from '../src/ui/ClipboardShortcuts';

type Keys = { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; type?: string };

function key(code: string, { ctrl = false, shift = false, alt = false, meta = false, type = 'keydown' }: Keys = {}) {
    return { type, code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta, preventDefault: vi.fn() };
}

describe('getClipboardAction', () => {
    describe.each<ShortcutPlatform>(['windows', 'linux'])('on %s', (platform) => {
        const action = (e: ReturnType<typeof key>, hasSelection = false) => getClipboardAction(e, platform, hasSelection);

        it('Ctrl+Shift+C copies', () => {
            expect(action(key('KeyC', { ctrl: true, shift: true }), true)).toBe('copy');
        });

        it('Ctrl+C copies (and clears the selection) when text is selected', () => {
            expect(action(key('KeyC', { ctrl: true }), true)).toBe('copy-and-clear');
        });

        it('Ctrl+C without a selection is left to the shell (interrupt)', () => {
            expect(action(key('KeyC', { ctrl: true }), false)).toBeNull();
        });

        it('Ctrl+Insert copies when text is selected', () => {
            expect(action(key('Insert', { ctrl: true }), true)).toBe('copy');
            expect(action(key('Insert', { ctrl: true }), false)).toBeNull();
        });

        it('Ctrl+Shift+V and Shift+Insert paste', () => {
            expect(action(key('KeyV', { ctrl: true, shift: true }))).toBe('paste');
            expect(action(key('Insert', { shift: true }))).toBe('paste');
        });

        it('ignores key combinations with Alt', () => {
            expect(action(key('KeyV', { ctrl: true, shift: true, alt: true }))).toBeNull();
        });

        it('only reacts to keydown', () => {
            expect(action(key('KeyV', { ctrl: true, shift: true, type: 'keyup' }))).toBeNull();
        });
    });

    it('Ctrl+V pastes on Windows', () => {
        expect(getClipboardAction(key('KeyV', { ctrl: true }), 'windows', false)).toBe('paste');
    });

    it('Ctrl+V is left to the shell on Linux (literal next, vim visual block)', () => {
        expect(getClipboardAction(key('KeyV', { ctrl: true }), 'linux', false)).toBeNull();
    });

    describe('on macOS', () => {
        it('Cmd+C copies when text is selected', () => {
            expect(getClipboardAction(key('KeyC', { meta: true }), 'mac', true)).toBe('copy');
            expect(getClipboardAction(key('KeyC', { meta: true }), 'mac', false)).toBeNull();
        });

        it('Cmd+V pastes', () => {
            expect(getClipboardAction(key('KeyV', { meta: true }), 'mac', false)).toBe('paste');
        });

        it('Ctrl+C is always left to the shell (interrupt)', () => {
            expect(getClipboardAction(key('KeyC', { ctrl: true }), 'mac', true)).toBeNull();
        });
    });
});

describe('attachClipboardShortcuts', () => {
    function setup(platform: ShortcutPlatform, selection = '') {
        let handler!: (e: KeyboardEvent) => boolean;
        const terminal = {
            attachCustomKeyEventHandler: vi.fn((h: (e: KeyboardEvent) => boolean) => { handler = h; }),
            hasSelection: vi.fn(() => selection !== ''),
            getSelection: vi.fn(() => selection),
            clearSelection: vi.fn(),
            paste: vi.fn()
        };
        const clipboard = {
            readText: vi.fn(async () => 'from clipboard'),
            writeText: vi.fn(async (_text: string) => {})
        };
        attachClipboardShortcuts(terminal, platform, clipboard);
        const press = (e: ReturnType<typeof key>) => handler(e as unknown as KeyboardEvent);
        return { terminal, clipboard, press };
    }

    it('should paste exactly once and block the browser\'s native paste', async () => {
        const { terminal, press } = setup('linux');
        const event = key('KeyV', { ctrl: true, shift: true });

        expect(press(event)).toBe(false);
        await vi.waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('from clipboard'));

        expect(event.preventDefault).toHaveBeenCalled();
        expect(terminal.paste).toHaveBeenCalledTimes(1);
    });

    it('should copy the selection and clear it for Ctrl+C', () => {
        const { terminal, clipboard, press } = setup('windows', 'ls -la');

        expect(press(key('KeyC', { ctrl: true }))).toBe(false);

        expect(clipboard.writeText).toHaveBeenCalledWith('ls -la');
        expect(terminal.clearSelection).toHaveBeenCalled();
    });

    it('should keep the selection for Ctrl+Shift+C', () => {
        const { terminal, clipboard, press } = setup('linux', 'ls -la');

        press(key('KeyC', { ctrl: true, shift: true }));

        expect(clipboard.writeText).toHaveBeenCalledWith('ls -la');
        expect(terminal.clearSelection).not.toHaveBeenCalled();
    });

    it('should let other keys through to the terminal', () => {
        const { press } = setup('windows');
        const event = key('KeyC', { ctrl: true });

        expect(press(event)).toBe(true);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should ignore clipboard read failures and empty clipboards', async () => {
        const { terminal, clipboard, press } = setup('windows');
        clipboard.readText.mockRejectedValueOnce(new Error('denied'));
        press(key('KeyV', { ctrl: true }));
        clipboard.readText.mockResolvedValueOnce('');
        press(key('KeyV', { ctrl: true }));
        await new Promise(r => setTimeout(r, 0));

        expect(terminal.paste).not.toHaveBeenCalled();
    });
});
