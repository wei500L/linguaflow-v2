FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ && corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/ ./packages/shared/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/ ./apps/api/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @linguaflow/shared build && pnpm --filter @linguaflow/api build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg curl \
 && mkdir -p /usr/share/fonts/linguaflow \
 && curl -fsSL -o /tmp/NotoSansCJKsc-Regular.otf \
    https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf \
 && echo "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b  /tmp/NotoSansCJKsc-Regular.otf" | sha256sum -c - \
 && mv /tmp/NotoSansCJKsc-Regular.otf /usr/share/fonts/linguaflow/NotoSansCJKsc-Regular.otf
ENV NODE_ENV=production
ENV PDF_FONT_PATH=/usr/share/fonts/linguaflow/NotoSansCJKsc-Regular.otf
ENV RECORDINGS_DIR=/data/recordings
RUN corepack enable
COPY --from=build /app /app
CMD ["node", "apps/api/dist/server.js"]
