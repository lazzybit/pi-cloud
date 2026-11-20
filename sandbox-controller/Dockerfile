FROM golang:1.27-alpine AS build
WORKDIR /src
COPY sandbox-controller/go.mod sandbox-controller/go.sum ./
RUN go mod download
COPY sandbox-controller/cmd ./cmd
COPY sandbox-controller/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /controller ./cmd/controller
FROM scratch
COPY --from=build /controller /controller
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/controller"]
