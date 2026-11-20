FROM gcc:14 AS build
COPY sandbox/guard.c /src/guard.c
RUN gcc -Os -static -s /src/guard.c -o /guard
FROM node:26-trixie-slim
WORKDIR /opt/terminal
RUN apt-get update && apt-get install --no-install-recommends -y python3 git curl ca-certificates && rm -rf /var/lib/apt/lists/* && install -d -o 65532 -g 65532 /workspace
COPY sandbox/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /guard ./guard
COPY sandbox/worker.ts ./
USER 65532:65532
EXPOSE 8282
CMD ["node","worker.ts"]
