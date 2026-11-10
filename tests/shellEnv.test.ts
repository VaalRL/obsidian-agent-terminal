import { describe, it, expect } from 'vitest';

import { buildShellEnv, ORIGINAL_NODE_PATH_VAR, TERMINAL_NAME } from '../src/services/shellEnv';

describe('buildShellEnv (environment of the user\'s shell)', () => {
    it('should not leak ELECTRON_RUN_AS_NODE, which would make Electron apps such as the Obsidian CLI start as plain Node', () => {
        const env = buildShellEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' });

        expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
        expect(env.PATH).toBe('/usr/bin');
    });

    it('should drop the plugin\'s own NODE_PATH when the user had none', () => {
        const env = buildShellEnv({ NODE_PATH: '/vault/.obsidian/plugins/agent-terminal/node_modules' });

        expect(env).not.toHaveProperty('NODE_PATH');
    });

    it('should restore the user\'s original NODE_PATH', () => {
        const env = buildShellEnv({
            NODE_PATH: '/vault/.obsidian/plugins/agent-terminal/node_modules',
            [ORIGINAL_NODE_PATH_VAR]: '/home/me/lib/node'
        });

        expect(env.NODE_PATH).toBe('/home/me/lib/node');
        expect(env).not.toHaveProperty(ORIGINAL_NODE_PATH_VAR);
    });

    it('should not modify the environment it was given', () => {
        const original = { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '/plugin/node_modules', NO_COLOR: '1' };

        buildShellEnv(original);

        expect(original).toEqual({ ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '/plugin/node_modules', NO_COLOR: '1' });
    });

    it('should drop NO_COLOR inherited from the program that launched Obsidian, so CLIs in the terminal keep their colors', () => {
        const env = buildShellEnv({ NO_COLOR: '1' });

        expect(env).not.toHaveProperty('NO_COLOR');
    });

    it('should announce a 256-color terminal with true color support (node-pty does not set TERM on Windows)', () => {
        const env = buildShellEnv({});

        expect(TERMINAL_NAME).toBe('xterm-256color');
        expect(env.TERM).toBe(TERMINAL_NAME);
        expect(env.COLORTERM).toBe('truecolor');
    });

    it('should replace an inherited TERM such as dumb, which turns colors off', () => {
        const env = buildShellEnv({ TERM: 'dumb' });

        expect(env.TERM).toBe(TERMINAL_NAME);
    });
});
