FROM node:26-trixie-slim AS build
WORKDIR /app
COPY harness/package*.json harness/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY harness/ ./
RUN npm run build && npm prune --omit=dev
FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node","dist/server/node.js"]
