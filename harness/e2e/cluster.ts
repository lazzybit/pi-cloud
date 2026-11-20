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
      await stop(p.child);
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
        image ? "docker" : process.execPath,
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
              "EGRESS_WEB",
              "-e",
              "BIND",
              "-e",
              "PORT",
              image,
            ]
          : ["sandbox/worker.ts"],
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
        const out = await k(
          req.url!.slice(1),
          req.method,
          raw ? JSON.parse(raw) : undefined,
        );
        if (!out) {
          res.writeHead(404).end();
          return;
        }
        res.end(JSON.stringify(out, (k, v) => (k === "child" ? undefined : v)));
      } catch {
        res.writeHead(503).end();
      }
    })
    .listen(35326, "127.0.0.1");
  return async () => {
    server.close();
    await Promise.all([...children].map(stop));
  };
}
