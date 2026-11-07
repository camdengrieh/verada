# Build context: repository root (the gateway consumes the workspace cause-catalog, sdk and
# endaoment-client packages, and serves the catalogue build baked in from .catalog/build).
#   docker build -f services/org-gateway/Dockerfile -t org-gateway:<namesRoot-prefix> .
# A new catalogue build means a new image tag: the image is the snapshot the gateway serves.
FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.0.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/endaoment-client/package.json packages/endaoment-client/package.json
COPY packages/cause-catalog/package.json packages/cause-catalog/package.json
COPY services/org-gateway/package.json services/org-gateway/package.json
RUN pnpm install --prod --frozen-lockfile --filter @varada/org-gateway...

FROM node:22-slim AS runtime
# ~240k orgs load into ~3 GB; the task has 4 GiB.
ENV NODE_ENV=production PORT=8790 ORG_BUILD_DIRS=/app/catalog-build NODE_OPTIONS=--max-old-space-size=3072
WORKDIR /app
RUN chown node:node /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=deps --chown=node:node /app/packages/endaoment-client/node_modules ./packages/endaoment-client/node_modules
COPY --from=deps --chown=node:node /app/packages/cause-catalog/node_modules ./packages/cause-catalog/node_modules
COPY --from=deps --chown=node:node /app/services/org-gateway/node_modules ./services/org-gateway/node_modules
COPY --chown=node:node packages/sdk/package.json ./packages/sdk/package.json
COPY --chown=node:node packages/sdk/src ./packages/sdk/src
COPY --chown=node:node packages/endaoment-client/package.json ./packages/endaoment-client/package.json
COPY --chown=node:node packages/endaoment-client/src ./packages/endaoment-client/src
COPY --chown=node:node packages/cause-catalog/package.json ./packages/cause-catalog/package.json
COPY --chown=node:node packages/cause-catalog/src ./packages/cause-catalog/src
COPY --chown=node:node tsconfig.base.json /app/tsconfig.base.json
# Only the built catalogue (catalog.json, orgs.jsonl, tree.json, labels.json, names-tree.json); never
# the harvest or the address cache.
COPY --chown=node:node .catalog/build /app/catalog-build
WORKDIR /app/services/org-gateway
COPY --chown=node:node services/org-gateway/package.json services/org-gateway/tsconfig.json ./
COPY --chown=node:node services/org-gateway/src ./src
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
