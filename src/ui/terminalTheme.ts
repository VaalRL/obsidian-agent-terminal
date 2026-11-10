import type { ITheme } from 'xterm';

/** 終端機容器的計算後樣式 (getComputedStyle 的子集，方便測試) */
export interface ContainerColors {
    backgroundColor: string;
    color: string;
}

const isUsable = (value: string) => {
    const color = value.trim();
    return color !== '' && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
};

/**
 * 依 Obsidian 目前的主題色產生 xterm 主題：xterm 會把 viewport 背景直接設成 theme.background，
 * 不支援 'transparent' (會變成黑色)；文字色也要跟著主題，淺色主題下才看得見。
 * 取不到的顏色不列出，由 xterm 使用預設值。
 */
export function terminalThemeFrom(colors: ContainerColors): ITheme {
    const theme: ITheme = {};
    const background = colors.backgroundColor.trim();
    const foreground = colors.color.trim();
    if (isUsable(background)) theme.background = background;
    if (isUsable(foreground)) {
        theme.foreground = foreground;
        theme.cursor = foreground;
    }
    if (theme.background && theme.cursor) theme.cursorAccent = theme.background;
    return theme;
}
