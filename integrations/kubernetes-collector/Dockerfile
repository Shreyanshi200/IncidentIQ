FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps apps
COPY packages packages
COPY integrations integrations

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @incidentiq/event-schema build && pnpm --filter @incidentiq/node-sdk build && pnpm --filter @incidentiq/kubernetes-collector build

USER node
CMD ["node", "integrations/kubernetes-collector/build/src/index.js"]
