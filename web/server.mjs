// Static SPA + public OIDC bootstrap only. Route /api/v1 separately at ingress.
import http from "node:http";
import { readFile } from "node:fs/promises";
const issuer = new URL(process.env.OIDC_ISSUER),
  client_id = process.env.OIDC_CLIENT_ID;
if (
  !client_id ||
  !(
    issuer.protocol === "https:" ||
    (issuer.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(issuer.hostname))
  )
)
  throw Error("invalid public OIDC settings");
const config = JSON.stringify({
  authority: process.env.OIDC_ISSUER,
  client_id,
});
http
  .createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader(
        "content-security-policy",
        `default-src 'self'; connect-src 'self' ${issuer.origin}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`,
      );
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (path === "/auth/config") {
        res.writeHead(200, { "content-type": "application/json" }).end(config);
        return;
      }
      const asset = /^\/assets\/[\w.-]+\.(js|css)$/.test(path);
      if (
        !asset &&
        !["/", "/callback"].includes(path) &&
        !/^\/c\/\d+$/.test(path)
      ) {
        res.writeHead(404).end();
        return;
      }
      const data = await readFile(
        new URL(asset ? "./dist" + path : "./dist/index.html", import.meta.url),
      );
      res
        .writeHead(200, {
          "content-type": asset
            ? path.endsWith(".js")
              ? "text/javascript"
              : "text/css"
            : "text/html; charset=utf-8",
        })
        .end(data);
    } catch {
      res.writeHead(404).end();
    }
  })
  .listen(Number(process.env.PORT ?? 8080), process.env.BIND ?? "0.0.0.0");
