# Org server (accounts, tagged usage events, aggregates, governed chat).
# Build from the repo root:
#   docker compose build server
#
# Runs TypeScript directly — Node's native type stripping — so the workspace
# packages are consumed from source (their package.json `exports` point at
# ./src/*.ts). No build step, prod deps only.
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile --prod

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    PP_DB=/data/promptpolice.db \
    PP_COOKIE_SECURE=1
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
WORKDIR /app/apps/server
EXPOSE 8787
CMD ["node", "--env-file-if-exists=.env", "src/index.ts"]