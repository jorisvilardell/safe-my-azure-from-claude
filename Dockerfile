# syntax=docker/dockerfile:1

# ---- build ----
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional: @azure/identity-broker (native Windows WAM, AUTH_MODE=broker) is not for the image.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=optional --prefer-offline
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional

# ---- runtime ----
FROM node:25-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    CONTEXTS_FILE=/app/config/contexts.yaml
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The server writes its MCP/admin keys to /run/safe-azure/keys.json (0600) at startup (ADR 0001).
# docker-compose mounts a tmpfs here; this directory is the fallback for a plain `docker run`.
RUN mkdir -p /run/safe-azure && chown node:node /run/safe-azure && chmod 700 /run/safe-azure
# The server only needs `node`. The npm, npx and corepack bundled with the base image are never
# run, but they ship their own dependencies (Trivy flags their CVEs) and are tools an attacker
# could use inside the container.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1
# --disable-sigusr1: SIGUSR1 would open the Node inspector, from which anyone who can signal the
# process (docker exec, a container sharing its PID namespace) could read the in-memory tokens.
CMD ["node", "--disable-sigusr1", "dist/main.js"]
