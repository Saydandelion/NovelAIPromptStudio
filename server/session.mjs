// NAS / 服务器版：把桌面版主进程里的数据层、命令分发和生成队列装在一个普通 Node 进程里。
// 数据全部放在 DATA_DIR（容器里映射到 NAS 的一个文件夹），重启后保留。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../electron/database.js';
import { openPreferences } from '../electron/preferences.js';
import { createCommands } from '../electron/commands/index.js';
import { importLibraryFiles } from '../electron/importer.js';
import {
  readWorkbenchImage,
  applyWorkbenchStructure,
  applyWorkbenchLibraryDetails,
} from '../electron/workbench.js';
import { createBackupManager } from '../electron/backup.js';
import { createLibraryExport } from '../electron/libraryExport.js';
import { createFolderImporter } from '../electron/folderImport.js';
import { createChatGPT, chatGPTCommands } from '../electron/chatgpt.js';
import { createPreviewHandlers } from '../preview/handlers.mjs';
import { networkFailure } from '../electron/network.js';

// 桌面版用系统钥匙串加密令牌；服务器上用数据目录里的一把随机密钥（AES-256-GCM）。
// 拿到整个数据目录的人也就拿到了令牌，这和把令牌写在 compose 文件里是一个安全等级。
function createSecretStore(directory) {
  const keyFile = path.join(directory, 'secret.key');
  let key;
  if (fs.existsSync(keyFile)) key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from('NPS1'), iv, cipher.getAuthTag(), body]);
    },
    decryptString(bytes) {
      const data = Buffer.from(bytes);
      if (data.subarray(0, 4).toString() !== 'NPS1') throw new Error('无法解密已保存的密钥');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
      decipher.setAuthTag(data.subarray(16, 32));
      return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8');
    },
  };
}

// 自动归档：生成图入库后复制一份原图（不重新编码，PNG 里的提示词元数据原样保留）到
//   <归档目录>/<作品名>/<YYYY-MM-DD>/<作品名>-<HHmmss>-<seed>.png
// 作品名要等生成队列把这张图挂到版本上之后才查得到，所以稍等一下再查；查不到就用 untitled。
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;
export const cleanName = (name, fallback = 'untitled') =>
  String(name || '')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim() || fallback;

export function createArchive({ root, versions, log = console.warn, wait = 500, tries = 20 }) {
  const pending = new Set();
  const pad = (n) => String(n).padStart(2, '0');
  function lookup(projectId) {
    const version = versions.forImage(projectId);
    if (!version) return null;
    const work = versions.work(version.workId);
    const seed = version.images?.find((i) => i.projectId === projectId)?.seed;
    return { name: work?.origin?.name, seed };
  }
  async function copy(image, source) {
    let found = null;
    for (let i = 0; i < tries && !found; i++) {
      try {
        found = lookup(image.id);
      } catch {
        // 版本还没写完，下一轮再试
      }
      if (!found) await new Promise((r) => setTimeout(r, wait));
    }
    const name = cleanName(found?.name || image.name);
    const seed = cleanName(found?.seed || image.metadata?.seed, 'noseed');
    const d = new Date();
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const folder = path.join(root, name, day);
    await fs.promises.mkdir(folder, { recursive: true });
    const from = fs.existsSync(image.image_path) ? image.image_path : source;
    const ext = path.extname(from) || '.png';
    for (let n = 1; ; n++) {
      const target = path.join(folder, `${name}-${time}-${seed}${n > 1 ? `-${n}` : ''}${ext}`);
      try {
        await fs.promises.copyFile(from, target, fs.constants.COPYFILE_EXCL);
        return target;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }
  return {
    schedule(image, source) {
      const job = copy(image, source)
        .catch((error) => log(`自动归档失败：${error.message}`))
        .finally(() => pending.delete(job));
      pending.add(job);
      return job;
    },
    idle: () => Promise.all([...pending]),
  };
}

export async function createServerSession({
  root,
  importRoots = [],
  archiveRoot = '',
  emit,
  version,
  novelBaseUrl,
}) {
  const dataDirectory = path.join(root, 'data');
  const assetsDirectory = path.join(root, 'assets');
  const uploads = path.join(root, 'uploads');
  const exportsDirectory = path.join(root, 'exports');
  const backups = path.join(root, 'backups');
  for (const dir of [dataDirectory, assetsDirectory, uploads, exportsDirectory, backups])
    fs.mkdirSync(dir, { recursive: true });

  const database = await openDatabase(dataDirectory);
  const preferences = openPreferences(dataDirectory, createSecretStore(dataDirectory), {
    defaultAssetsDirectory: assetsDirectory,
    platform: 'linux',
  });
  preferences.onboardingSettings?.(() => database.hasOnboardingHistory());

  const roots = [root, ...importRoots]
    .filter((r) => fs.existsSync(r))
    .map((r) => fs.realpathSync(r));
  const allowedPath = (file) => {
    const resolved = fs.realpathSync(String(file));
    if (!roots.some((r) => resolved === r || resolved.startsWith(r + path.sep)))
      throw Error('只能访问数据目录和导入目录里的文件');
    return resolved;
  };
  const readImage = (file) =>
    readWorkbenchImage(allowedPath(file), { enrichProjectTags: database.enrichProjectTags });

  const adapter = createPreviewHandlers({
    database,
    preferences,
    dataDirectory,
    assetsDirectory,
    readImage,
    emit,
    state: { slowImport: false },
  });
  const handlers = adapter.handlers;

  const chatGPT = createChatGPT({
    preferences,
    clientVersion: version,
    emit,
    // 服务器上打不开浏览器：把登录地址推给前端，由前端在新标签页打开
    openExternal: async (url) => emit({ type: 'server-open-url', url }),
  });
  Object.assign(
    handlers,
    chatGPTCommands(chatGPT, preferences, async (url) => emit({ type: 'server-open-url', url })),
  );

  // 网络：服务器版统一用容器的 HTTPS_PROXY 环境变量（Node 24 加 NODE_USE_ENV_PROXY=1）
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const networkState = () => ({
    settings: { mode: 'system' },
    pending: null,
    phase: 'ready',
    error: null,
    active: 0,
    serverProxy: proxy,
  });
  Object.assign(handlers, {
    'settings.network.get': networkState,
    'settings.network.save': () => {
      throw Object.assign(new Error('服务器版的代理在 Docker 环境变量 HTTPS_PROXY 里设置'), {
        code: 'invalid_input',
      });
    },
    // 返回格式和桌面版一致：{reachable, status, failure, elapsedMs}
    'settings.network.test': async () => {
      const start = Date.now();
      try {
        const res = await fetch('https://image.novelai.net/', {
          method: 'HEAD',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        await res.body?.cancel();
        return {
          reachable: true,
          status: res.status,
          failure: null,
          elapsedMs: Date.now() - start,
        };
      } catch (error) {
        return {
          reachable: false,
          status: null,
          failure: networkFailure(error.cause || error),
          elapsedMs: Date.now() - start,
        };
      }
    },
  });

  // 更新：服务器版不能在应用内下载安装，只查上游有没有新版本，提示去更新镜像
  const previewCheck = handlers['updates.check'];
  const previewStatus = handlers['updates.status'];
  const withVersion = (status) =>
    status && typeof status === 'object' ? { ...status, currentVersion: version } : status;
  const newer = (a, b) => {
    const x = a.split('.').map(Number),
      y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  Object.assign(handlers, {
    'updates.check': async (input, caller) => {
      try {
        const res = await fetch(
          'https://api.github.com/repos/LBEILC/NovelAIPromptStudio/releases/latest',
          {
            headers: { Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(10000),
          },
        );
        const tag = String((await res.json()).tag_name || '').replace(/^v/, '');
        if (tag && newer(tag, version))
          return { ok: false, error: `上游已发布 ${tag}（当前 ${version}），请更新 Docker 镜像` };
      } catch {
        return { ok: false, error: '检查更新失败：连不上 GitHub' };
      }
      return withVersion(await previewCheck(input, caller));
    },
    'updates.status': async (input, caller) => withVersion(await previewStatus(input, caller)),
    'updates.download': () => ({ ok: false, error: '服务器版请更新 Docker 镜像' }),
    'updates.install': () => ({ ok: false, error: '服务器版请更新 Docker 镜像' }),
  });

  const generatedDirectory = path.join(dataDirectory, 'generated');
  const archive = archiveRoot
    ? createArchive({ root: archiveRoot, versions: database.versions })
    : null;

  const commands = await createCommands({
    directory: dataDirectory,
    version,
    database,
    preferences,
    generationBaseUrl: novelBaseUrl,
    fetcher: (...args) => globalThis.fetch(...args),
    handlers,
    busy: () => false,
    emit,
    readImage,
    readSource: async (source) => {
      const library = source.type === 'library' ? database.loadProject(source.projectId) : null;
      const file = library?.image_path || source.path;
      return applyWorkbenchLibraryDetails(
        applyWorkbenchStructure(await readImage(file), database.loadWorkbenchStructure(file)),
        library,
      );
    },
    importImage: async (file, draft) => {
      allowedPath(file);
      const result = await importLibraryFiles({
        filePaths: [file],
        assetsDirectory,
        database,
        prepareProject: async (p) => database.enrichProjectTags(p),
      });
      const id = result.imported[0]?.id || result.duplicates[0]?.projectId;
      if (draft && id) database.saveProjectPrompt(id, draft);
      if (!id) throw Error(result.errors[0]?.error || '导入失败');
      const image = database.loadProject(id);
      // 生成队列把结果先写到 data/generated/ 再调用这里；手动导入走的是别的路径
      if (archive && path.dirname(path.resolve(file)) === generatedDirectory)
        archive.schedule(image, file);
      return image;
    },
    remember: (tab) => {
      if (tab.project && tab.source.path)
        database.rememberWorkbenchStructure(tab.source.path, tab.project.prompt_structure);
    },
  });

  const sender = new EventEmitter();
  sender.id = 1;
  sender.isDestroyed = () => false;
  sender.send = (_, event) => emit(event);

  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  // 导出图片：没有"另存为"对话框，ZIP 写到 exports 目录后由浏览器下载；文件夹导出直接留在 NAS 的 exports 目录
  const libraryExport = createLibraryExport({
    database,
    owner: () => null,
    dialog: {
      showSaveDialog: async (_owner, options = {}) => ({
        canceled: false,
        filePath: path.join(
          exportsDirectory,
          path.basename(options.defaultPath || `导出 ${stamp()}.zip`),
        ),
      }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [exportsDirectory] }),
    },
    progress: (data) => emit({ type: 'progress', topic: 'library.export-progress', data }),
  });
  Object.assign(handlers, libraryExport);

  const backup = createBackupManager({
    dataDirectory,
    assetsDirectory: () => assetsDirectory,
    database,
    preferences,
    session: commands.store,
    version,
    busy: () => false,
    progress: (data) => emit({ type: 'progress', topic: 'backup.progress', data }),
    reload: () => emit({ type: 'server-reload' }),
  });
  const result = async (operation) => {
    try {
      return { ok: true, ...(await operation()) };
    } catch (error) {
      return { ok: false, error: error.name === 'AbortError' ? '操作已取消' : error.message };
    }
  };
  Object.assign(handlers, {
    'backup.estimate': () => result(() => backup.estimate()),
    'backup.status': () => backup.status(),
    'backup.cancel': () => backup.cancel(),
    'backup.export': (input) =>
      result(() =>
        backup.export(
          path.join(backups, `NovelAI Prompt Studio 备份 ${stamp()}.npsbackup`),
          input.includeLibrary,
        ),
      ),
    'backup.inspect': (input) => {
      if (!input.path) return { canceled: true };
      allowedPath(input.path);
      return result(() => backup.inspect(input.path));
    },
    'backup.restore': (input) => {
      allowedPath(input.path);
      return result(() => backup.restore(input.path));
    },
    'backup.undo': () => result(() => backup.undo()),
  });

  // 导入文件夹：不传路径时扫描映射进容器的导入目录（比如 NAS 上存图的文件夹）
  const folderImporter = createFolderImporter({
    database,
    assetsDirectory: () => assetsDirectory,
    activeImports: new Map(),
  });
  const folderProgress = (data) =>
    emit({ type: 'progress', topic: 'library:import-progress', data });
  Object.assign(handlers, {
    'import.folder.scan': async (input) => {
      try {
        const target = input.path || importRoots.find((r) => fs.existsSync(r));
        if (!target) return { ok: false, error: '没有映射导入目录（容器里的 /import）' };
        allowedPath(target);
        return { ok: true, ...(await folderImporter.scan(target, folderProgress)) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    'import.folder.commit': async (input) => {
      try {
        return { ok: true, ...(await folderImporter.commit(input, folderProgress)) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    'storage.change': () => ({
      ok: false,
      error: '服务器版的资源库固定在数据目录的 assets 里，换位置请改 Docker 的目录映射',
    }),
  });

  // 清理旧上传：超过 14 天、且没有被工作台标签页引用的上传目录
  try {
    const referenced = JSON.stringify(commands.store.get()?.tabs || []);
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(uploads)) {
      const entry = path.join(uploads, name);
      if (fs.statSync(entry).mtimeMs < cutoff && !referenced.includes(entry))
        fs.rmSync(entry, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('清理旧上传失败：', error.message);
  }

  const dispatch = (name, input = {}, origin = 'ui') =>
    commands.dispatch(name, input, origin, sender);

  return {
    root,
    uploads,
    database,
    preferences,
    commands,
    dispatch,
    allowedPath,
    get restoring() {
      return Boolean(backup.restoring);
    },
    async close() {
      chatGPT.close();
      await commands.close();
      await archive?.idle();
      await adapter.close();
      database.close();
    },
  };
}
