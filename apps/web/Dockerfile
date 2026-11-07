# Web bundle — build from the repo root:
#   docker compose build web
#
# The org API is NOT proxied by this container: on the shared Traefik edge
# /api belongs to another app, so the bundle is built with VITE_API_BASE=/pp
# and Traefik routes /pp/api/* straight to the `server` service with a
# stripprefix (see docker-compose.yml).
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
ARG VITE_API_BASE=/pp
ENV VITE_API_BASE=$VITE_API_BASE
RUN corepack enable && pnpm install --frozen-lockfile \
  && pnpm --filter @promptslim/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80