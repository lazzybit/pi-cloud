FROM gcc:14 AS guard
COPY sandbox/guard/guard.c /src/guard.c
RUN gcc -Os -static -s /src/guard.c -o /guard
FROM golang:1.27-alpine AS supervisor
WORKDIR /src
COPY sandbox/go.mod sandbox/go.sum ./
RUN go mod download
COPY sandbox/cmd ./cmd
COPY sandbox/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /sandboxd ./cmd/sandboxd
FROM debian:trixie-slim
WORKDIR /opt/terminal
RUN apt-get update && apt-get install --no-install-recommends -y python3 git curl ca-certificates tini && rm -rf /var/lib/apt/lists/* && install -d -o 65532 -g 65532 /workspace
COPY --from=guard /guard ./guard
COPY --from=supervisor /sandboxd ./sandboxd
USER 65532:65532
EXPOSE 8282
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/terminal/sandboxd"]
