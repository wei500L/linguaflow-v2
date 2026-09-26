FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ && corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/ ./packages/shared/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/ ./apps/api/
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @linguaflow/shared build && pnpm --filter @linguaflow/api build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg curl \
 && mkdir -p /usr/share/fonts/linguaflow \
 && curl -fsSL -o /usr/share/fonts/linguaflow/NotoSansCJKsc-Regular.otf \
    https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf
ENV PDF_FONT_PATH=/usr/share/fonts/linguaflow/NotoSansCJKsc-Regular.otf
ENV RECORDINGS_DIR=/data/recordings
RUN corepack enable
COPY --from=build /app /app
CMD ["node", "apps/api/dist/server.js"]
