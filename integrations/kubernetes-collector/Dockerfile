FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps apps
COPY packages packages
COPY integrations integrations

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @incidentiqhq/event-schema build && pnpm --filter @incidentiqhq/node-sdk build && pnpm --filter @incidentiqhq/kubernetes-collector build

USER node
CMD ["node", "integrations/kubernetes-collector/build/src/index.js"]
