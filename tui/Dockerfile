FROM node:26-trixie-slim AS build
WORKDIR /src/tui
COPY contract/ /src/contract/
COPY tui/package*.json tui/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY tui/ ./
RUN npm run build
FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /src/tui/dist dist
USER node
ENTRYPOINT ["node","dist/tui.mjs"]
