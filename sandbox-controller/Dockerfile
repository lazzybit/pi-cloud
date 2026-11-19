FROM node:26-trixie-slim
WORKDIR /app
COPY sandbox-controller/*.mjs ./
USER node
EXPOSE 8081
CMD ["node","server.mjs"]
