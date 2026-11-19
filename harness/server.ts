import http from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { implement } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { runtime } from "./runtime.ts";
import { contract } from "../contract/contract.ts";
import { verifier, trustedUrl, type Identity } from "./auth.ts";
function required(k: string) {
  if (!process.env[k]) throw Error("missing " + k);
  return process.env[k]!;
}
const origin = trustedUrl(required("PUBLIC_ORIGIN")),
  issuer = required("OIDC_ISSUER"),
  client_id = required("OIDC_CLIENT_ID");
const verify = verifier(issuer, required("OIDC_AUDIENCE"));
const db = new Client({
  connectionString: required("DATABASE_URL"),
  keepAlive: true,
});
db.on("error", () => process.exit(1));
await db.connect();
while (
  !(await db.query("SELECT pg_try_advisory_lock(742037391) AS active")).rows[0]
    .active
)
  await sleep(400);
const app = await runtime(
  db,
  required("MODEL_BASE_URL"),
  required("MODEL_ID"),
  process.env.MODEL_CHOICES,
);
const impl = implement(contract).$context<Identity>();
const api = new OpenAPIHandler(
  impl.router({
    create: impl.create.handler(({ context }) => app.create(context.owner)),
    list: impl.list.handler(({ context }) => app.list(context.owner)),
    configure: impl.configure.handler(async ({ input, context }) => {
      await app.owned(context.owner, input.id);
      return app.configure(input.id, input.settings);
    }),
    send: impl.send.handler(async ({ input, context }) => {
      await app.owned(context.owner, input.id);
      return app.send(input.id, input.requestId, input.text, context);
    }),
    watch: impl.watch.handler(async ({ input, context, signal }) => {
      await app.owned(context.owner, input.id);
      const expiry = AbortSignal.timeout(
        Math.max(1, Math.min(2147483647, context.expires - Date.now())),
      );
      return app.watch(
        input.id,
        signal ? AbortSignal.any([signal, expiry]) : expiry,
      );
    }),
    stop: impl.stop.handler(async ({ input, context }) => {
      await app.owned(context.owner, input.id);
      return app.stop(input.id, input.requestId);
    }),
  }),
);
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url!, origin).pathname;
    if (
      req.headers.host !== origin.host ||
      (req.headers.origin && req.headers.origin !== origin.origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      `default-src 'self'; connect-src 'self' ${trustedUrl(issuer).origin}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`,
    );
    if (path.startsWith("/api/v1/")) {
      let identity;
      try {
        identity = await verify(req.headers.authorization);
      } catch {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      if (
        (await api.handle(req, res, { prefix: "/api/v1", context: identity }))
          .matched
      )
        return;
    }
    if (req.method === "GET") {
      if (path === "/auth/config") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ authority: issuer, client_id }));
        return;
      }
      if (path === "/" || path === "/callback" || /^\/c\/\d+$/.test(path)) {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(readFileSync("dist/index.html"));
        return;
      }
      if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) {
        res
          .writeHead(200, {
            "content-type": path.endsWith(".js")
              ? "text/javascript"
              : "text/css",
          })
          .end(readFileSync("dist" + path));
        return;
      }
    }
    res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(
  Number(process.env.PORT ?? 8080),
  process.env.BIND ?? "0.0.0.0",
  () => console.info("active"),
);
process.once("SIGTERM", async () => {
  server.close();
  setTimeout(() => process.exit(1), 10000).unref();
  await app.close();
  await db.end();
  process.exit(0);
});
