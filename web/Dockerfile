FROM node:26-trixie-slim AS build
WORKDIR /src/web
COPY contract/ /src/contract/
COPY web/package*.json web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build
FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /src/web/dist dist
COPY web/server.mjs ./
USER node
EXPOSE 8080
CMD ["node","server.mjs"]
