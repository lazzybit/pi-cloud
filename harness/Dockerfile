FROM node:26-trixie-slim AS build
WORKDIR /src/harness
COPY contract/ /src/contract/
COPY harness/package*.json harness/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY harness/ ./
RUN npm run build && npm prune --omit=dev
FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /src/harness/node_modules node_modules
COPY --from=build /src/harness/dist dist
USER node
EXPOSE 8080
CMD ["node","dist/server.mjs"]
