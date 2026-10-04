FROM node:22.22-alpine3.22 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:22.22-alpine3.22

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# The router reads and writes .oauth-tokens.json and .router-mappings.json
# relative to the working directory, so keep it on the persistent volume.
WORKDIR /data

EXPOSE 3000

CMD ["node", "/app/dist/router/server.js", "--disable-bearer-passthrough"]
