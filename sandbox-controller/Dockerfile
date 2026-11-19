FROM node:26-trixie-slim AS build
WORKDIR /src
COPY sandbox-controller/package*.json ./
RUN npm ci --no-audit --no-fund
COPY sandbox-controller/*.ts sandbox-controller/tsconfig*.json ./
RUN npm run build

FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8081
CMD ["node","dist/server.js"]
