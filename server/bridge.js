// 服务器版的浏览器入口：用 HTTP + SSE 提供桌面版 preload 里的 window.studio

// 用 http://局域网IP 打开时浏览器不算安全上下文，没有 crypto.randomUUID（界面里很多地方用它生成 ID）。
// getRandomValues 不受限制，用它按 RFC 4122 v4 补上。
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}
const events = new Set(),
  preparations = new Set(),
  uploads = new Map();
const files = new WeakMap();
let preparation;
async function prepareUI() {
  if (!preparation) {
    preparation = (async () => {
      for (const callback of preparations) await callback();
    })().finally(() => {
      preparation = undefined;
    });
  }
  await preparation;
}
async function request(endpoint, data) {
  const res = await fetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio': '1' },
    body: JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok) throw Error(result.error);
  return result;
}
const IMAGE_TYPES = '.png,.jpg,.jpeg,.webp';
function chooseFiles(multiple, accept = IMAGE_TYPES + ',.zip') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    input.onchange = () => resolve(Array.from(input.files || []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}
function pathsForFiles(list) {
  return Array.from(list || [], (file) => {
    if (files.has(file)) return files.get(file);
    const id = `server-upload:${crypto.randomUUID()}`;
    files.set(file, id);
    uploads.set(
      id,
      fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'X-Studio': '1' },
        body: file,
      }).then(async (res) => {
        const result = await res.json();
        if (!res.ok) throw Error(result.error);
        return result.path;
      }),
    );
    return id;
  });
}
async function resolveUploads(value) {
  if (typeof value === 'string' && uploads.has(value)) return uploads.get(value);
  if (Array.isArray(value)) return Promise.all(value.map(resolveUploads));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveUploads(v)])),
    );
  return value;
}
function download(file, name) {
  const a = document.createElement('a');
  a.href = `/api/download?path=${encodeURIComponent(file)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
  a.download = name || '';
  document.body.append(a);
  a.click();
  a.remove();
}
const canceled = {
  ok: true,
  data: { ok: true, canceled: true, project: null, imported: [], duplicates: [], errors: [] },
};
async function copyImage(file) {
  // 浏览器只在 HTTPS 或 localhost 下允许写入图片剪贴板
  if (!window.isSecureContext || !navigator.clipboard?.write || !window.ClipboardItem)
    return { ok: true, data: { ok: false, error: '浏览器只在 HTTPS 下允许复制图片，请改用下载' } };
  const blob = await (await fetch(`/api/media?path=${encodeURIComponent(file)}`)).blob();
  const png =
    blob.type === 'image/png'
      ? blob
      : await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            c.toBlob(resolve, 'image/png');
          };
          img.src = URL.createObjectURL(blob);
        });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  return { ok: true, data: { ok: true } };
}
async function imagePath(input) {
  if (input.path) return input.path;
  if (input.id) {
    const r = await request('invoke', { name: 'library.get', input: { id: input.id } });
    return r.data?.project?.image_path;
  }
}

window.studio = {
  pathsForFiles,
  onCommandEvent(callback) {
    events.add(callback);
    return () => events.delete(callback);
  },
  onCommandPrepare(callback) {
    preparations.add(callback);
    return () => preparations.delete(callback);
  },
  async invoke(name, input = {}) {
    if (name === 'version.list') await prepareUI();
    // 桌面版在这些命令里弹系统的选择文件框；网页里改用浏览器的文件选择并先上传
    if (
      (['import.prepare', 'import.files'].includes(name) &&
        !input.paths?.length &&
        !input.fromClipboard) ||
      (name === 'workbench.open' && !input.path && !input.source && !input.libraryId)
    ) {
      const selected = await chooseFiles(name !== 'workbench.open');
      if (!selected.length) return canceled;
      const paths = pathsForFiles(selected);
      input = name === 'workbench.open' ? { ...input, path: paths[0] } : { ...input, paths };
    }
    if (
      ['reference.add-vibe', 'reference.add-precise'].includes(name) &&
      !input.path &&
      !input.imageId &&
      !input.libraryId
    ) {
      const accept =
        name === 'reference.add-vibe' ? IMAGE_TYPES + ',.naiv4vibe,.naiv4vibebundle' : IMAGE_TYPES;
      const [file] = await chooseFiles(false, accept);
      if (!file) return { ok: true, data: { ok: true, canceled: true } };
      input = { ...input, path: pathsForFiles([file])[0] };
    }
    if (name === 'backup.inspect' && !input.path) {
      const [file] = await chooseFiles(false, '.npsbackup');
      if (!file) return { ok: true, data: { canceled: true } };
      input = { path: pathsForFiles([file])[0] };
    }
    if (name === 'window.close-choice' || name === 'tray.menu-size' || name === 'tray.action')
      return { ok: true, data: {} };
    if (name === 'clipboard.write-text') {
      try {
        await navigator.clipboard.writeText(String(input.text ?? ''));
        return { ok: true, data: undefined };
      } catch {
        // 非 HTTPS 下没有剪贴板 API，用老办法
        const t = document.createElement('textarea');
        t.value = String(input.text ?? '');
        document.body.append(t);
        t.select();
        document.execCommand('copy');
        t.remove();
        return { ok: true, data: undefined };
      }
    }
    if (name === 'clipboard.read-text') {
      try {
        return { ok: true, data: await navigator.clipboard.readText() };
      } catch {
        return { ok: true, data: '' };
      }
    }
    if (name === 'image.save-as') {
      const file = await imagePath(input);
      if (file) {
        const ext = file.slice(file.lastIndexOf('.'));
        const base = input.name || file.split('/').pop();
        download(file, base.toLowerCase().endsWith(ext) ? base : base + ext);
        return { ok: true, data: { ok: true, filePath: file } };
      }
    }
    if (name === 'image.copy') {
      const file = await imagePath(input);
      if (file) return copyImage(file);
    }
    const result = await request('invoke', { name, input: await resolveUploads(input) });
    // 导出、备份写在服务器的数据目录里，ZIP 和备份文件再让浏览器下载一份
    const data = result?.data;
    if (result?.ok && data?.ok && typeof data.path === 'string') {
      if (name === 'library.export' && data.path.endsWith('.zip')) download(data.path);
      if (name === 'backup.export') download(data.path);
    }
    if (result?.ok && name === 'backup.export' && data?.ok && data.filePath)
      download(data.filePath);
    return result;
  },
};

function connect() {
  const stream = new EventSource('/api/events');
  stream.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'server-reload') return location.reload();
    if (message.type === 'server-open-url') return void window.open(message.url, '_blank');
    for (const callback of events) callback(message);
  };
}
connect();
await import('/src/main.tsx');
