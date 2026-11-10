import * as fs from 'fs';
import * as path from 'path';

/** 在 root 建立一個假的 node-pty 套件目錄結構 (供打包/安裝測試使用) */
export function makeFakeNodePty(root: string, binaryContent = 'binary') {
    const write = (rel: string, content = rel) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };
    write('package.json', JSON.stringify({ name: 'node-pty', version: '1.1.0', main: './lib/index.js' }));
    write('lib/index.js');
    write('lib/worker/conoutSocketWorker.js');
    write('lib/index.js.map');
    write('lib/windowsTerminal.test.js');
    write('prebuilds/darwin-arm64/pty.node');
    write('prebuilds/darwin-arm64/spawn-helper');
    write('prebuilds/win32-x64/pty.node');
    write('prebuilds/win32-x64/pty.pdb');
    write('prebuilds/win32-x64/winpty-agent.exe');
    write('prebuilds/win32-x64/conpty/OpenConsole.exe');
    write('build/Release/pty.node', `linux ${binaryContent}`);
}
