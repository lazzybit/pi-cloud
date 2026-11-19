import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { lifecycle } from "./lifecycle.ts";
const sa = "/var/run/secrets/kubernetes.io/serviceaccount/",
  ns = (await readFile(sa + "namespace", "utf8")).trim(),
  ca = await readFile(sa + "ca.crt");
const key = process.env.CONTROLLER_KEY || "",
  idle = Number(process.env.IDLE_SECONDS ?? 600) * 1000;
if (key.length < 32 || !Number.isFinite(idle) || idle < 1000)
  throw Error("invalid controller config");
const config = {
  image: process.env.SANDBOX_IMAGE ?? "",
  runtimeClass: process.env.RUNTIME_CLASS || "",
  revision: process.env.PROFILE_REVISION || "1",
  storageClass: process.env.STORAGE_CLASS || "",
  size: process.env.VOLUME_SIZE || "2Gi",
};
async function k<T>(path: string, method = "GET", data?: object): Promise<T> {
  const token = (await readFile(sa + "token", "utf8")).trim();
  return new Promise<T>((resolve, reject) => {
    const q = https.request(
      `https://kubernetes.default.svc/api/v1/namespaces/${ns}/${path}`,
      {
        ca,
        method,
        headers: {
          authorization: "Bearer " + token,
          "content-type":
            method === "PATCH"
              ? "application/merge-patch+json"
              : "application/json",
        },
      },
      (r) => {
        let s = "";
        r.on("data", (b) => (s += b));
        r.on("end", () => {
          try {
            if (r.statusCode === 404 && method === "GET") resolve(null as T);
            else if (!r.statusCode || r.statusCode >= 300)
              reject(Error("kubernetes " + r.statusCode));
            else resolve(JSON.parse(s));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    q.setTimeout(8000, () => q.destroy(Error("timeout")));
    q.on("error", reject);
    q.end(data && JSON.stringify(data));
  });
}
const { act, sweep } = lifecycle(k, config, idle);
setInterval(sweep, 5000).unref();
http
  .createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/lifecycle") {
        res.writeHead(404).end();
        return;
      }
      const h = Buffer.from(req.headers.authorization || ""),
        v = Buffer.from("Bearer " + key);
      if (h.length !== v.length || !timingSafeEqual(h, v)) {
        res.writeHead(403).end();
        return;
      }
      let s = "";
      for await (const b of req) {
        s += b;
        if (s.length > 4096) throw Error("invalid body");
      }
      const result = await act(JSON.parse(s));
      res
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(result));
    } catch {
      res.writeHead(503).end();
    }
  })
  .listen(8081);
