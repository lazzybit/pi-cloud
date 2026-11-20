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
  const containerNames = new Map();
  async function stop(child) {
    const name = containerNames.get(child);
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, "exit");
    if (name) {
      await once(
        spawn("docker", ["rm", "-f", name], { stdio: "ignore" }),
        "exit",
      );
      containerNames.delete(child);
    } else child.kill();
    await exited;
  }
  async function k(path, method = "GET", data) {
    if (method === "GET" && path === "pods")
      return {
        apiVersion: "v1", kind: "PodList", metadata: {},
        items: [...resources]
          .filter(([p]) => p.startsWith("pods/"))
          .map(([, v]) => v),
      };
    if (method === "GET") return resources.get(path) ?? null;
    if (method === "DELETE") {
      const p = resources.get(path);
      if (p.metadata.uid !== data.preconditions.uid || p.metadata.resourceVersion !== data.preconditions.resourceVersion) throw Error("stale pod");
      await stop(p.child);
      resources.delete(path);
      return { apiVersion: "v1", kind: "Status", status: "Success" };
    }
    if (method === "PATCH") {
      const p = resources.get(path);
      if (p.metadata.resourceVersion !== data.metadata.resourceVersion) throw Error("stale pod");
      for (const [k, v] of Object.entries(data.metadata.annotations)) {
        if (v === null) delete p.metadata.annotations[k];
        else p.metadata.annotations[k] = v;
      }
      p.metadata.resourceVersion = String(Number(p.metadata.resourceVersion) + 1);
      return p;
    }
    const p = structuredClone(data);
    p.metadata.uid = randomUUID();
    p.metadata.resourceVersion = "1";
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
        image ? "docker" : process.env.SANDBOXD!,
        image
          ? [
              "run",
              "--rm",
              "--name",
              `pi-e2e-${p.metadata.uid}`,
              "--network",
              "host",
              "--user",
              `${process.getuid()}:${process.getgid()}`,
              "--mount",
              `type=bind,src=${workspace},dst=/workspace`,
              "-e",
              "RUNTIME_KEY",
              "-e",
              "SANDBOX_POD_UID",
              "-e",
              "BIND",
              "-e",
              "PORT",
              image,
            ]
          : [],
        {
          env: {
            ...process.env,
            ...env,
            SANDBOX_POD_UID: p.metadata.uid,
            BIND: ip,
            PORT: "8282",
            WORKSPACE: workspace,
            GUARD: process.env.SANDBOX_GUARD ? resolve(process.env.SANDBOX_GUARD) : undefined,
          },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      if (image) containerNames.set(child, `pi-e2e-${p.metadata.uid}`);
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
  const server = http
    .createServer(async (req, res) => {
      try {
        if (req.headers.authorization !== "Bearer " + key) {
          res.writeHead(403).end();
          return;
        }
        let raw = "";
        for await (const b of req) raw += b;
        const prefix = "/api/v1/namespaces/fixture/";
        const path = new URL(req.url!, "http://localhost").pathname;
        if (!path.startsWith(prefix)) throw Error("unexpected Kubernetes path");
        const out = await k(
          path.slice(prefix.length),
          req.method,
          raw ? JSON.parse(raw) : undefined,
        );
        res.setHeader("content-type", "application/json");
        if (!out) {
          res.writeHead(404).end(JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", reason: "NotFound", code: 404 }));
          return;
        }
        res.end(JSON.stringify(out, (k, v) => (k === "child" ? undefined : v)));
      } catch (error) {
        console.error("Kubernetes fixture request failed", req.method, req.url, error instanceof SyntaxError ? "expected JSON" : "operation failed");
        res.writeHead(503).end();
      }
    })
    .listen(35326, "127.0.0.1");
  return async () => {
    server.close();
    await Promise.all([...children].map(stop));
  };
}
