// NovelAI Prompt Studio 服务器版：一个端口同时提供网页和接口，给 NAS 上的 Docker 用。
//   STUDIO_DATA      数据目录，默认 ./studio-data（容器里是 /data）
//   STUDIO_IMPORT    导入目录，可用英文逗号分隔多个（容器里是 /import），只读也行
//   STUDIO_PORT      端口，默认 8960
//   STUDIO_PASSWORD  访问密码（浏览器弹框登录，用户名随意）；不设就不需要密码
//   STUDIO_ARCHIVE   自动归档目录（容器里是 /output）；不设就不归档
//   NOVELAI_BASE_URL 生成接口地址，默认官方 https://image.novelai.net（只用于本机测试）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { blurredMedia } from '../electron/blurMedia.js';
import { createServerSession, cleanName } from './session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dataRoot = path.resolve(process.env.STUDIO_DATA || path.join(root, 'studio-data'));
const importRoots = (process.env.STUDIO_IMPORT || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(s));
const port = Number(process.env.STUDIO_PORT || 8960);
const host = process.env.STUDIO_HOST || '0.0.0.0';
const password = process.env.STUDIO_PASSWORD || '';
const webRoot = path.join(root, 'dist-web');
const MAX_UPLOAD = Number(process.env.STUDIO_MAX_UPLOAD_MB || 4096) * 1024 * 1024;

const clients = new Set();
const emit = (event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
};

fs.mkdirSync(dataRoot, { recursive: true });
const session = await createServerSession({
  root: dataRoot,
  importRoots,
  archiveRoot: process.env.STUDIO_ARCHIVE ? path.resolve(process.env.STUDIO_ARCHIVE) : '',
  emit,
  version: pkg.version,
  novelBaseUrl: process.env.NOVELAI_BASE_URL || undefined,
});

const json = (res, data, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
const readBody = async (req, limit = 64 * 1024 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error('请求太大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
function validatePaths(value, key = '') {
  if (
    typeof value === 'string' &&
    ['path', 'filePath', 'image_path', 'thumbnail_path', 'previewPath', 'paths'].includes(key)
  ) {
    if (value) session.allowedPath(value);
  } else if (Array.isArray(value)) value.forEach((v) => validatePaths(v, key));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) validatePaths(v, k);
}
const safeEqual = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function authorized(req) {
  if (!password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  return safeEqual(decoded.slice(decoded.indexOf(':') + 1), password);
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};
function serveStatic(req, res, pathname) {
  let file = path.join(webRoot, decodeURIComponent(pathname));
  if (!file.startsWith(webRoot + path.sep)) return json(res, { error: 'Not found' }, 404);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(webRoot, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}
async function sendFile(req, res, file, { download, name } = {}) {
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=300',
  };
  if (download)
    headers['Content-Disposition'] =
      `attachment; filename*=UTF-8''${encodeURIComponent(name || path.basename(file))}`;
  res.writeHead(200, headers);
  await pipeline(fs.createReadStream(file), res).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  try {
    // 健康检查不需要密码，也不返回任何数据
    if (req.url === '/api/health') return json(res, { ok: true });
    if (!authorized(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="NovelAI Prompt Studio", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      return res.end('需要密码');
    }
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    const route = url.pathname.slice(4);
    if (route === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': ready\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (route === '/media' || route === '/download') {
      let file = session.allowedPath(url.searchParams.get('path'));
      if (url.searchParams.get('blur') === '1')
        file = await blurredMedia(file, path.join(session.root, 'assets', 'blurred'));
      return sendFile(req, res, file, {
        download: route === '/download',
        name: url.searchParams.get('name') || undefined,
      });
    }
    if (route === '/status')
      return json(res, { version: pkg.version, server: true, imports: importRoots });
    // 自定义请求头让浏览器对跨站请求先做预检，而这里不放行任何跨站来源
    if (req.method !== 'POST' || req.headers['x-studio'] !== '1')
      return json(res, { error: 'Request rejected' }, 403);
    if (route === '/upload') {
      const original = path.basename(url.searchParams.get('name') || 'image.png');
      const ext = path.extname(original).toLowerCase();
      if (
        ![
          '.png',
          '.jpg',
          '.jpeg',
          '.webp',
          '.zip',
          '.npsbackup',
          '.naiv4vibe',
          '.naiv4vibebundle',
        ].includes(ext)
      )
        throw Error('不支持的文件格式');
      // 每次上传一个子目录，保留原文件名（导入图库和工作台标签会用它当名字）
      const folder = path.join(session.uploads, crypto.randomUUID());
      fs.mkdirSync(folder);
      const file = path.join(folder, cleanName(original.slice(0, -ext.length), 'image') + ext);
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) req.destroy(Error('文件太大'));
      });
      await pipeline(req, fs.createWriteStream(file));
      return json(res, { path: file });
    }
    if (route === '/invoke') {
      const input = JSON.parse((await readBody(req)).toString() || '{}');
      if (session.restoring && !['backup.cancel', 'backup.status'].includes(input.name))
        return json(res, { ok: false, error: { code: 'app_busy', message: '正在恢复备份' } });
      validatePaths(input.input);
      return json(res, await session.dispatch(input.name, input.input || {}));
    }
    json(res, { error: 'Not found' }, 404);
  } catch (error) {
    if (!res.headersSent) json(res, { error: error.message }, 400);
    else res.end();
  }
});
server.requestTimeout = 0;
server.listen(port, host, () => {
  console.log(`NovelAI Prompt Studio ${pkg.version} 服务器版：http://${host}:${port}/`);
  console.log('数据目录：', dataRoot);
  if (importRoots.length) console.log('导入目录：', importRoots.join(', '));
  if (process.env.STUDIO_ARCHIVE)
    console.log('自动归档：', path.resolve(process.env.STUDIO_ARCHIVE));
  if (!password) console.log('提示：没有设置 STUDIO_PASSWORD，局域网内任何人都能打开');
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    for (const c of clients) c.end();
    server.closeAllConnections();
    server.close();
    try {
      await session.close();
    } catch (error) {
      console.error(error);
    }
    process.exit(0);
  });
