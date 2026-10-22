FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps apps
COPY packages packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @incidentiq/event-schema build && pnpm --filter @incidentiq/api build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "apps/api/dist/src/main.js"]
