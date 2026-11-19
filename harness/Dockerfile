FROM node:26-trixie-slim AS build
WORKDIR /app
COPY package*.json ./
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY contract contract
COPY web web
COPY harness harness
COPY tsconfig.json ./
RUN npm run build && npm prune --omit=dev
FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/harness/dist harness/dist
USER node
EXPOSE 8080
CMD ["node","harness/dist/server.mjs"]
