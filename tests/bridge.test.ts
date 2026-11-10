import { describe, it, expect, afterEach } from 'vitest';
import { startBridge, BridgeHarness } from './helpers/bridgeHarness';

// 以系統 node 實際執行打包後的 bridge.ts (搭配假的 node-pty)，驗證行程間的 I/O 行為
describe('bridge.js (integration)', () => {
    let bridge: BridgeHarness;

    afterEach(async () => {
        await bridge?.cleanup();
    });

    const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error('timed out');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    };

    it('should pass a multi-byte character split across two stdin chunks to the PTY intact', async () => {
        bridge = startBridge();
        const bytes = Buffer.from('中', 'utf8');

        bridge.child.stdin!.write(bytes.subarray(0, 1));
        await new Promise(resolve => setTimeout(resolve, 100));
        bridge.child.stdin!.write(bytes.subarray(1));

        await waitFor(() => bridge.output().includes(']'));
        expect(bridge.output()).toBe('[中]');
    });
});

describe('bridge.js exit (integration)', () => {
    let bridge: BridgeHarness;

    afterEach(async () => {
        await bridge?.cleanup();
    });

    // stdout 非同步寫入時 (macOS 的 pipe)，onExit 直接 process.exit 會截斷尚未寫出的輸出
    it('should flush all PTY output to stdout before exiting when the shell ends', async () => {
        bridge = startBridge({ asyncStdout: true });

        bridge.child.stdin!.write('FLOOD');
        const code = await bridge.exited;

        expect(code).toBe(0);
        expect(bridge.output().length).toBe(4 * 1024 * 1024 + 'END'.length);
        expect(bridge.output().endsWith('END')).toBe(true);
    });
});
