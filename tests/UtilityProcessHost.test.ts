import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

import { electronUtilityHost, ElectronLike } from '../src/services/UtilityProcessHost';

function fakeElectron() {
    const ipcRenderer = new EventEmitter();
    const child = { postMessage: vi.fn(), kill: vi.fn() };
    const port1 = { name: 'port1' };
    const port2 = { name: 'port2' };
    const webContents = { postMessage: vi.fn() };
    const electron = {
        ipcRenderer,
        remote: {
            utilityProcess: { fork: vi.fn(() => child) },
            MessageChannelMain: vi.fn(function () { return { port1, port2 }; }),
            getCurrentWebContents: () => webContents
        }
    };
    return { electron, child, port1, port2, webContents, ipcRenderer };
}

describe('electronUtilityHost', () => {
    it('should be unavailable when Obsidian does not expose remote.utilityProcess', () => {
        expect(electronUtilityHost({ ipcRenderer: new EventEmitter() } as unknown as ElectronLike)).toBeNull();
        expect(electronUtilityHost({ ipcRenderer: new EventEmitter(), remote: {} } as unknown as ElectronLike)).toBeNull();
        expect(electronUtilityHost(null)).toBeNull();
    });

    it('should fork the module with the given arguments, cwd and environment', () => {
        const { electron } = fakeElectron();
        const host = electronUtilityHost(electron as unknown as ElectronLike)!;

        host.start('/plugin/bridge.js', ['/bin/sh', '/vault', '80', '24'], { cwd: '/plugin', env: { PATH: '/usr/bin' } });

        expect(electron.remote.utilityProcess.fork).toHaveBeenCalledWith(
            '/plugin/bridge.js',
            ['/bin/sh', '/vault', '80', '24'],
            expect.objectContaining({ cwd: '/plugin', env: { PATH: '/usr/bin' }, serviceName: 'Agent Terminal' })
        );
    });

    // 只有建立連線時經過 remote (同步 IPC)；之後的輸入輸出走 MessagePort，不經過主程序轉送
    it('should give one end of a new channel to the bridge and send the other end to this window', async () => {
        const { electron, child, port2, port1, webContents, ipcRenderer } = fakeElectron();
        const host = electronUtilityHost(electron as unknown as ElectronLike)!;

        const started = host.start('/plugin/bridge.js', [], { cwd: '/plugin', env: {} });

        expect(child.postMessage).toHaveBeenCalledWith(null, [port2]);
        expect(webContents.postMessage).toHaveBeenCalledWith(expect.any(String), null, [port1]);

        const rendererPort = { postMessage: vi.fn() };
        const channel = webContents.postMessage.mock.calls[0][0];
        ipcRenderer.emit(channel, { ports: [rendererPort] });
        await expect(started.port).resolves.toBe(rendererPort);
    });

    it('should use a different channel for every terminal', () => {
        const { electron, webContents } = fakeElectron();
        const host = electronUtilityHost(electron as unknown as ElectronLike)!;

        host.start('/plugin/bridge.js', [], { cwd: '/plugin', env: {} });
        host.start('/plugin/bridge.js', [], { cwd: '/plugin', env: {} });

        const [first, second] = webContents.postMessage.mock.calls.map(call => call[0]);
        expect(first).not.toBe(second);
    });

    it('should stop the utility process through the returned handle', () => {
        const { electron, child } = fakeElectron();
        const host = electronUtilityHost(electron as unknown as ElectronLike)!;

        host.start('/plugin/bridge.js', [], { cwd: '/plugin', env: {} }).child.kill();

        expect(child.kill).toHaveBeenCalled();
    });
});
