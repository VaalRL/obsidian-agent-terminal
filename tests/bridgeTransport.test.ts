import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

import { createPortTransport, receivePort, MainPortLike } from '../src/services/bridgeTransport';

// Electron 的 MessagePortMain：以 'message' 事件傳出 { data }，另一端關閉時觸發 'close'
class FakeMainPort extends EventEmitter implements MainPortLike {
    sent: unknown[] = [];
    started = false;
    postMessage(message: unknown) { this.sent.push(message); }
    start() { this.started = true; }
    receive(data: unknown) { this.emit('message', { data }); }
}

function setup() {
    const port = new FakeMainPort();
    const exitProcess = vi.fn();
    const transport = createPortTransport(port, exitProcess);
    return { port, exitProcess, transport };
}

describe('receivePort (utility process)', () => {
    it('should resolve with the MessagePort transferred in the first parentPort message', async () => {
        const parentPort = new EventEmitter();
        const port = new FakeMainPort();

        const received = receivePort(parentPort);
        parentPort.emit('message', { data: null, ports: [port] });

        await expect(received).resolves.toBe(port);
    });
});

describe('createPortTransport (utility process)', () => {
    it('should start the port so queued messages are delivered', () => {
        const { port } = setup();

        expect(port.started).toBe(true);
    });

    it('should pass input messages to the input callback and other messages to the control callback', () => {
        const { port, transport } = setup();
        const onInput = vi.fn();
        const onControl = vi.fn();
        transport.onInput(onInput);
        transport.onControl(onControl);

        port.receive({ type: 'input', data: 'ls\r' });
        port.receive({ type: 'resize', cols: 100, rows: 40 });

        expect(onInput).toHaveBeenCalledWith('ls\r');
        expect(onControl).toHaveBeenCalledWith({ type: 'resize', cols: 100, rows: 40 });
        expect(onControl).toHaveBeenCalledTimes(1);
    });

    it('should send PTY output and replies as messages', () => {
        const { port, transport } = setup();

        transport.sendData('hello');
        transport.reply({ type: 'process', id: 3, name: null });

        expect(port.sent).toEqual([
            { type: 'data', data: 'hello' },
            { type: 'process', id: 3, name: null }
        ]);
    });

    // 立刻結束程序可能丟掉還在傳送中的訊息：只回報結束，由外掛收到後關閉 port 並結束程序
    it('should report the exit code without exiting, so no output is lost', () => {
        const { port, transport, exitProcess } = setup();

        transport.sendData('last words');
        transport.exit(0);

        expect(port.sent).toEqual([{ type: 'data', data: 'last words' }, { type: 'exit', code: 0 }]);
        expect(exitProcess).not.toHaveBeenCalled();
    });

    it('should report a failure as an error followed by exit code 1', () => {
        const { port, transport } = setup();

        transport.fail('Failed to load node-pty');

        expect(port.sent).toEqual([{ type: 'error', message: 'Failed to load node-pty' }, { type: 'exit', code: 1 }]);
    });

    // 外掛關閉終端機或 Obsidian 重新載入時 port 會關閉：清理 PTY 後結束程序，不留下孤兒程序
    it('should run close callbacks and exit when the plugin side closes the port', () => {
        const { port, transport, exitProcess } = setup();
        const onClose = vi.fn();
        transport.onClose(onClose);

        port.emit('close');

        expect(onClose).toHaveBeenCalled();
        expect(exitProcess).toHaveBeenCalledWith(0);
    });

    it('should exit even when a close callback throws', () => {
        const { port, transport, exitProcess } = setup();
        transport.onClose(() => { throw new Error('already dead'); });

        port.emit('close');

        expect(exitProcess).toHaveBeenCalledWith(0);
    });
});
