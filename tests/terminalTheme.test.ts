import { describe, it, expect } from 'vitest';
import { terminalThemeFrom } from '../src/ui/terminalTheme';

// xterm 會把 viewport 的背景直接設成主題的 background (不支援 'transparent'，會變成黑色)，
// 所以主題要用 Obsidian 目前的實際顏色，淺色主題下文字也才看得見
describe('terminalThemeFrom', () => {
    it('should use the computed background and text colours of the terminal container', () => {
        expect(terminalThemeFrom({ backgroundColor: 'rgb(28, 28, 28)', color: 'rgb(218, 218, 218)' })).toEqual({
            background: 'rgb(28, 28, 28)',
            foreground: 'rgb(218, 218, 218)',
            cursor: 'rgb(218, 218, 218)',
            cursorAccent: 'rgb(28, 28, 28)'
        });
    });

    it('should leave out colours that are not available, so xterm keeps its defaults', () => {
        expect(terminalThemeFrom({ backgroundColor: '', color: ' ' })).toEqual({});
        expect(terminalThemeFrom({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(1, 2, 3)' }))
            .toEqual({ foreground: 'rgb(1, 2, 3)', cursor: 'rgb(1, 2, 3)' });
    });
});
