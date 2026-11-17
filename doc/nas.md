# 服务器版（NAS / Docker）部署说明

把 NovelAI Prompt Studio 跑在 NAS 的 Docker 里，用浏览器访问。数据、图库都存在 NAS 上；每张生成图还会自动复制一份到你指定的文件夹。

> 这是社区改版，不是原作者的官方版本。业务代码和界面都来自上游，新增部分在 `server/` 目录。

## 一、拿到镜像

任选一种：

**A. 用 GitHub 自动构建（推荐）**
1. 在 GitHub 上 fork 本仓库，推送 `nas-web` 分支（或在 Actions 页手动运行 "NAS image"）。
2. 构建完成后有两种产物：
   - 镜像 `ghcr.io/<你的用户名>/nai-studio:latest`。第一次构建后，到 GitHub 个人主页 → Packages → nai-studio → Package settings，把可见性改成 Public，NAS 才能免登录拉取。
   - 这次运行页面底部的 Artifacts 里有 `nai-studio-amd64`，下载解压后得到 `nai-studio-amd64.tar.gz`。**国内拉不动 ghcr.io 时用这个**：极空间 Docker → 镜像 → 添加 → 本地导入。

**B. 在自己电脑上构建**（电脑要装 Docker）
```bash
docker build -t nai-studio:latest .
# 国内可加：--build-arg NPM_REGISTRY=https://registry.npmmirror.com
docker save nai-studio:latest | gzip > nai-studio-amd64.tar.gz
```
然后同样用"本地导入"传到极空间。

极空间 Z4 是 x86 机型，用 amd64 镜像即可。

## 二、准备文件夹

在极空间上建三个文件夹（名字随意），例如：

| 用途 | 示例 | 容器里的位置 |
|---|---|---|
| 程序数据（数据库、图库、备份）| `AI绘图/studio-data` | `/data` |
| 自动归档 | `AI绘图/生成` | `/output` |
| 要导入的老图（可选，只读）| `AI绘图/老图` | `/import` |

## 三、启动

极空间 Docker → Compose → 新建项目，粘贴仓库里的 `docker-compose.yml`，按注释改三处：镜像名、访问密码、三个文件夹路径。启动后浏览器打开 `http://<NAS 局域网 IP>:8960`，用户名随便填，密码填你设的。

不想用 Compose 的话，在极空间的容器向导里手动填同样的内容也可以：端口 8960，三个文件夹映射，环境变量见下表。

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `STUDIO_PASSWORD` | 访问密码；不设就不需要密码（**不建议**） | 无 |
| `STUDIO_ARCHIVE` | 自动归档目录；不设就不归档 | 无 |
| `STUDIO_IMPORT` | 导入目录，可用英文逗号分隔多个 | 无 |
| `STUDIO_DATA` | 数据目录 | `/data` |
| `STUDIO_PORT` | 端口 | `8960` |
| `STUDIO_MAX_UPLOAD_MB` | 单个上传文件上限 | `4096` |
| `TZ` | 时区，影响归档文件夹的日期 | `Asia/Shanghai` |
| `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` | 需要代理才能连 NovelAI 时再设 | 无（直连） |

## 四、外网访问

在极空间 App 里添加一个 Docker 远程访问连接，端口填 `8960`，就能在外面打开。请务必设置访问密码：页面背后就是你的 NovelAI 令牌和 Anlas。

## 五、自动归档

每张生成图（包括增强、局部重绘、扩图等操作产生的图）入库后，会把原图复制到：

```
/output/<作品名>/<日期>/<作品名>-<时间>-<seed>.png
```

复制的是原文件，PNG 里的提示词和参数都在，拖回软件就能还原。这个文件夹完全归你管，删改都不影响程序自己的图库。

## 六、和桌面版的不同

- **打开、导入图片**：用浏览器的选择文件或拖放，文件会先上传到 NAS。
- **导出 ZIP、导出备份**：浏览器会下载一份，同时在数据目录的 `exports/`、`backups/` 里留一份。导出成文件夹的结果在 `exports/` 里。
- **导入文件夹**：扫描的是映射到 `/import` 的目录。
- **资源库位置**：固定在数据目录的 `assets/`，换位置请改目录映射。
- **网络设置**：网页里改不了，代理用环境变量设置。
- **更新**："检查更新"只会告诉你上游有没有新版本，更新方法是换新镜像后重建容器。
- **复制图片到剪贴板**：浏览器要求 HTTPS；用 `http://` 访问时请改用"另存为"。
- **没有的功能**：系统托盘、应用内安装更新、ChatGPT 账号登录（可以改用 API Key 方式接 AI 服务）、Agent 命令行工具。
- **单用户**：所有打开页面的设备共享同一个图库和工作台。

## 七、备份与升级

- **备份**：定期备份整个程序数据文件夹（`/data`）。注意，`data/secret.key` 是令牌的加密密钥，拿到它和数据库的人就能解出令牌，请妥善保管。
- **升级**：拿到新镜像后，在极空间里重建容器（数据都在映射的文件夹里，不会丢）。

## 八、开发者

```bash
npm ci --ignore-scripts
npm run build:web       # 打包前端到 dist-web/
npm run start:server    # STUDIO_DATA 默认 ./studio-data
```

服务器版文件：

| 文件 | 内容 |
|---|---|
| `server/start.mjs` | HTTP 服务、鉴权、上传、媒体、SSE |
| `server/session.mjs` | 数据层装配、命令覆盖、密钥存储、自动归档 |
| `server/bridge.js` | 浏览器端的 `window.studio` |
| `server/vite.config.mjs` | 前端打包配置 |

业务层复用 `preview/handlers.mjs`（预览模式里的主进程适配）。跟进上游后，请比对它和 `electron/main.js` 的命令有没有对上。
