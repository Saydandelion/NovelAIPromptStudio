# NovelAI Prompt Studio 服务器版（NAS / Docker）
# 构建：docker build -t nai-studio .
# 国内构建可加：--build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY . .
RUN npm run build:web

FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV NODE_ENV=production \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    STUDIO_DATA=/data \
    STUDIO_PORT=8960 \
    TZ=Asia/Shanghai
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=${NPM_REGISTRY} \
 && npm cache clean --force
COPY server ./server
COPY electron ./electron
COPY src ./src
COPY preview/handlers.mjs ./preview/handlers.mjs
COPY LICENSE ./LICENSE
COPY --from=build /app/dist-web ./dist-web
RUN find electron -name '*.test.*' -delete && rm -rf electron/fixtures electron/acceptance \
 && mkdir -p /data
VOLUME ["/data"]
EXPOSE 8960
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STUDIO_PORT||8960)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/start.mjs"]
