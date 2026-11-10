import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // obsidian 套件沒有執行期進入點，測試時改用 mock
      obsidian: path.resolve(__dirname, 'tests/__mocks__/obsidian.ts'),
      // electron 由 Obsidian 在執行期提供，測試環境沒有；需要時測試會自行注入假的 Electron
      electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
