FROM golang:1.27-alpine AS build
WORKDIR /src
COPY sandbox-controller/go.mod sandbox-controller/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /controller .
FROM scratch
COPY --from=build /controller /controller
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/controller"]
