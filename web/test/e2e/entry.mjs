// Loopback fixture for the two independent production ingress routes.
import http from "node:http";
export const apiPort = 38444,
  webPort = 38445;
export function entry() {
  return http
    .createServer((req, res) => {
      const port = req.url.startsWith("/api/v1/") ? apiPort : webPort;
      const up = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${port}`,
            origin:
              req.headers.origin === "http://127.0.0.1:38443"
                ? `http://127.0.0.1:${port}`
                : (req.headers.origin ?? `http://127.0.0.1:${port}`),
          },
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.on("error", () => res.destroy());
          r.pipe(res);
        },
      );
      res.on("close", () => up.destroy());
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    })
    .listen(38443, "127.0.0.1");
}
