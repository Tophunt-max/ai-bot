# Build from repo root:  docker build -f services/execution-gateway/Dockerfile -t atb-gateway .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/execution-gateway ./services/execution-gateway
RUN pnpm install --frozen-lockfile --filter @atb/execution-gateway... \
 && pnpm --filter @atb/execution-gateway run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /repo/services/execution-gateway/dist/main.js ./main.js
ENV NODE_ENV=production
EXPOSE 8080
USER nonroot
CMD ["main.js"]
