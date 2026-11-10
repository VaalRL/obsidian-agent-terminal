import { describe, it, expect } from 'vitest';

import { detectObsidianCli, prependPath, CliHost } from '../src/services/ObsidianCli';

function host(overrides: Partial<CliHost> & { files?: string[] }): CliHost {
    const files = new Set(overrides.files ?? []);
    return {
        platform: 'darwin',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        execPath: '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
        homedir: '/Users/me',
        appVersionOk: true,
        exists: (p: string) => files.has(p),
        ...overrides
    };
}

describe('detectObsidianCli', () => {
    it('should report an outdated Obsidian (the CLI needs 1.12.4+)', () => {
        expect(detectObsidianCli(host({ appVersionOk: false, files: ['/usr/local/bin/obsidian'] })))
            .toEqual({ state: 'outdated' });
    });

    it('should find the CLI on the PATH', () => {
        const result = detectObsidianCli(host({
            env: { PATH: '/usr/bin:/usr/local/bin' },
            files: ['/usr/local/bin/obsidian']
        }));

        expect(result).toEqual({ state: 'available', path: '/usr/local/bin/obsidian', dir: '/usr/local/bin', onPath: true });
    });

    it('macOS: should find the registered symlink even when the Dock-launched app has a minimal PATH', () => {
        const result = detectObsidianCli(host({ files: ['/usr/local/bin/obsidian'] }));

        expect(result).toEqual({ state: 'available', path: '/usr/local/bin/obsidian', dir: '/usr/local/bin', onPath: false });
    });

    it('Linux: should find the copy in ~/.local/bin', () => {
        const result = detectObsidianCli(host({
            platform: 'linux',
            env: { PATH: '/usr/bin:/bin' },
            execPath: '/opt/Obsidian/obsidian',
            homedir: '/home/me',
            files: ['/home/me/.local/bin/obsidian']
        }));

        expect(result).toEqual({ state: 'available', path: '/home/me/.local/bin/obsidian', dir: '/home/me/.local/bin', onPath: false });
    });

    it('Windows: should find Obsidian.com next to Obsidian.exe when the new PATH has not reached Obsidian yet', () => {
        const result = detectObsidianCli(host({
            platform: 'win32',
            env: { Path: 'C:\\Windows\\system32;C:\\Windows' },
            execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe',
            homedir: 'C:\\Users\\me',
            files: ['C:\\Users\\me\\AppData\\Local\\Programs\\Obsidian\\Obsidian.com']
        }));

        expect(result).toEqual({
            state: 'available',
            path: 'C:\\Users\\me\\AppData\\Local\\Programs\\Obsidian\\Obsidian.com',
            dir: 'C:\\Users\\me\\AppData\\Local\\Programs\\Obsidian',
            onPath: false
        });
    });

    it('Windows: should look for Obsidian.com on the PATH (Path key, ; separator)', () => {
        const result = detectObsidianCli(host({
            platform: 'win32',
            env: { Path: 'C:\\Windows;D:\\Apps\\Obsidian' },
            execPath: 'D:\\Apps\\Obsidian\\Obsidian.exe',
            files: ['D:\\Apps\\Obsidian\\Obsidian.com']
        }));

        expect(result).toMatchObject({ state: 'available', onPath: true });
    });

    it('should not mistake the Windows GUI executable for the CLI', () => {
        const result = detectObsidianCli(host({
            platform: 'win32',
            env: { Path: 'D:\\Apps\\Obsidian' },
            execPath: 'D:\\Apps\\Obsidian\\Obsidian.exe',
            files: ['D:\\Apps\\Obsidian\\Obsidian.exe']
        }));

        expect(result).toEqual({ state: 'not-registered' });
    });

    it('should report a CLI that has not been registered yet', () => {
        expect(detectObsidianCli(host({}))).toEqual({ state: 'not-registered' });
    });
});

describe('prependPath', () => {
    it('should add a directory in front of the POSIX PATH', () => {
        expect(prependPath({ PATH: '/usr/bin:/bin', HOME: '/h' }, '/usr/local/bin', 'darwin'))
            .toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/h' });
    });

    it('should not add a directory twice', () => {
        expect(prependPath({ PATH: '/usr/local/bin:/usr/bin' }, '/usr/local/bin', 'linux').PATH).toBe('/usr/local/bin:/usr/bin');
    });

    it('should keep the existing key case on Windows (Path) and use ;', () => {
        const env = prependPath({ Path: 'C:\\Windows' }, 'D:\\Apps\\Obsidian', 'win32');

        expect(env).toEqual({ Path: 'D:\\Apps\\Obsidian;C:\\Windows' });
    });

    it('should create PATH when there is none', () => {
        expect(prependPath({}, '/usr/local/bin', 'darwin')).toEqual({ PATH: '/usr/local/bin' });
    });

    it('should not modify the environment it was given', () => {
        const env = { PATH: '/usr/bin' };
        prependPath(env, '/usr/local/bin', 'darwin');
        expect(env).toEqual({ PATH: '/usr/bin' });
    });
});
