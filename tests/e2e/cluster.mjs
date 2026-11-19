// Implement just the Kubernetes resources used by the driver; run the real worker/guard.
import { lifecycle } from "../../sandbox-controller/lifecycle.mjs";
import { spawn } from "node:child_process";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
export function cluster(dir, key) {
  const resources = new Map(),
    children = new Set();
  let n = 1;
  async function k(path, method = "GET", data) {
    if (path.includes("?"))
      return {
        items: [...resources]
          .filter(([p]) => p.startsWith("pods/"))
          .map(([, v]) => v),
      };
    if (method === "GET") return resources.get(path) ?? null;
    if (method === "DELETE") {
      const p = resources.get(path);
      if (p.metadata.uid !== data.preconditions.uid) throw Error("uid");
      p.child.kill();
      await once(p.child, "exit");
      resources.delete(path);
      return {};
    }
    if (method === "PATCH") {
      Object.assign(
        resources.get(path).metadata.annotations,
        data.metadata.annotations,
      );
      return resources.get(path);
    }
    const p = structuredClone(data);
    p.metadata.uid = randomUUID();
    resources.set(path + "/" + p.metadata.name, p);
    if (path === "pods") {
      const ip = "127.0.0." + ++n,
        vol =
          p.spec.volumes[0].persistentVolumeClaim?.claimName ?? p.metadata.uid,
        workspace = dir + "/" + vol;
      await mkdir(workspace, { recursive: true });
      const env = Object.fromEntries(
        p.spec.containers[0].env.map((e) => [e.name, e.value]),
      );
      const image = process.env.WORKER_IMAGE;
      const child = spawn(
        image ? "docker" : "python3",
        image
          ? [
              "run",
              "--rm",
              "--network",
              "host",
              "--user",
              `${process.getuid()}:${process.getgid()}`,
              "--mount",
              `type=bind,src=${workspace},dst=/workspace`,
              "-e",
              "RUNTIME_KEY",
              "-e",
              "EGRESS_WEB",
              "-e",
              "BIND",
              "-e",
              "PORT",
              image,
            ]
          : ["sandbox/worker.py"],
        {
          env: {
            ...process.env,
            ...env,
            BIND: ip,
            PORT: "8282",
            WORKSPACE: workspace,
            GUARD: resolve("sandbox/guard"),
          },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      children.add(child);
      child.once("exit", () => children.delete(child));
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw Error("worker failed");
        }),
      ]);
      p.child = child;
      p.status = {
        podIP: ip,
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
      };
    }
    return p;
  }
  const { act } = lifecycle(
    k,
    { image: "fixture@sha256:" + "a".repeat(64) },
    600000,
  );
  const server = http
    .createServer(async (req, res) => {
      try {
        if (req.headers.authorization !== "Bearer " + key) {
          res.writeHead(403).end();
          return;
        }
        let s = "";
        for await (const b of req) s += b;
        res.end(JSON.stringify(await act(JSON.parse(s))));
      } catch {
        res.writeHead(503).end();
      }
    })
    .listen(35325, "127.0.0.1");
  return () => {
    server.close();
    for (const c of children) c.kill();
  };
}
