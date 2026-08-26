# Builds and runs the FlowBridge signaling/relay server standalone.
# Build context must be the REPO ROOT (not apps/server), because it needs
# the sibling packages/protocol workspace package too:
#   docker build -f apps/server/Dockerfile -t flowbridge-relay .
# fly.toml's default [build] block does exactly this automatically.

FROM node:20-slim AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
RUN npm install --workspace=packages/protocol --workspace=apps/server --include-workspace-root

COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN npm run build --workspace=packages/protocol \
 && npm run build --workspace=apps/server

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /repo/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/server/package.json ./apps/server/package.json

EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
