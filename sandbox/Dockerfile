FROM gcc:14 AS build
COPY sandbox/guard.c /src/guard.c
RUN gcc -Os -static -s /src/guard.c -o /guard
FROM python:3.13-trixie
RUN apt-get update && apt-get install --no-install-recommends -y git curl ca-certificates && rm -rf /var/lib/apt/lists/* && install -d -o 65532 -g 65532 /workspace
COPY --from=build /guard /opt/terminal/guard
COPY sandbox/worker.py /opt/terminal/worker.py
USER 65532:65532
EXPOSE 8282
CMD ["python3","-I","/opt/terminal/worker.py"]
