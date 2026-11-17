import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanName, createArchive } from './session.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nps-archive-'));
const files = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll('\\', '/'));

describe('cleanName', () => {
  it('去掉路径和控制字符，空名用默认值', () => {
    expect(cleanName('a/b\\c:d*e?"<>|')).toBe('a b c d e');
    expect(cleanName('..')).toBe('untitled');
    expect(cleanName('', 'x')).toBe('x');
    expect(cleanName('  夜间  书店 ')).toBe('夜间 书店');
    expect(cleanName('a'.repeat(200))).toHaveLength(80);
  });
});

describe('createArchive', () => {
  it('按作品名和日期复制原图，重名加序号', async () => {
    const root = temp(),
      src = path.join(temp(), 'x.png');
    fs.writeFileSync(src, 'png-bytes');
    const versions = {
      forImage: (id) => ({ workId: 'w1', images: [{ projectId: id, seed: '123' }] }),
      work: () => ({ origin: { name: '雨/夜' } }),
    };
    const archive = createArchive({ root, versions, wait: 1 });
    const image = { id: 'p1', image_path: src, metadata: {} };
    archive.schedule(image, src);
    archive.schedule(image, src);
    await archive.idle();
    const list = files(root).sort();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatch(/^雨 夜\/\d{4}-\d{2}-\d{2}\/雨 夜-\d{6}-123(-2)?\.png$/);
    expect(fs.readFileSync(path.join(root, list[0]), 'utf8')).toBe('png-bytes');
  });

  it('查不到版本时用图片名，复制失败不抛出', async () => {
    const root = temp(),
      src = path.join(temp(), 'y.png');
    fs.writeFileSync(src, 'y');
    const logs = [];
    const archive = createArchive({
      root,
      versions: { forImage: () => null, work: () => null },
      wait: 1,
      tries: 2,
      log: (m) => logs.push(m),
    });
    archive.schedule({ id: 'p', name: 'pic', image_path: src, metadata: { seed: 9 } }, src);
    await archive.idle();
    expect(files(root)[0]).toMatch(/^pic\/.+\/pic-\d{6}-9\.png$/);
    archive.schedule(
      { id: 'q', name: 'gone', image_path: '/no/such.png', metadata: {} },
      '/no/such.png',
    );
    await archive.idle();
    expect(logs[0]).toMatch(/自动归档失败/);
  });
});
