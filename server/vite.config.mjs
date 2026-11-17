// 服务器版前端打包：入口 server/index.html → server/bridge.js → src/main.tsx，输出到 dist-web/
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { bundledMiSans } from '../scripts/font-vite.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'dist-web');

// 桌面版用 novelai-media:// 协议读本地图片，网页里改成 HTTP 接口
const serverMedia = {
  name: 'nps-server-media',
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/lib/imageStage.js')) return;
    if (!code.includes('novelai-media://file?path='))
      throw Error('imageStage 里没找到媒体协议，上游可能改了');
    return code.replaceAll('novelai-media://file?path=', '/api/media?path=');
  },
};
// 让 index.html 落在 dist-web 根目录
const flattenEntry = {
  name: 'nps-server-entry',
  closeBundle() {
    const nested = path.join(outDir, 'server', 'index.html');
    if (fs.existsSync(nested)) {
      fs.renameSync(nested, path.join(outDir, 'index.html'));
      fs.rmSync(path.join(outDir, 'server'), { recursive: true, force: true });
    }
  },
};

export default defineConfig({
  root,
  base: '/',
  publicDir: path.join(root, 'public'),
  plugins: [react(), bundledMiSans(), serverMedia, flattenEntry],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    rollupOptions: { input: path.join(root, 'server', 'index.html') },
  },
});
