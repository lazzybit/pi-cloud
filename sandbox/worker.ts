import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { type } from "arktype";
import { webProxy } from "./egress.ts";
const workspace = process.env.WORKSPACE ?? "/workspace",
  guard = process.env.GUARD ?? "/opt/terminal/guard",
  key = process.env.RUNTIME_KEY;
if (!key || key.length < 32) throw Error("credential required");
const expected = Buffer.from("Bearer " + key),
  boot = randomUUID();
await mkdir(workspace + "/.tmp", { recursive: true });
execFileSync(guard, [workspace, "true"], { env: { PATH: "/usr/bin:/bin" } });
const proxy = process.env.EGRESS_WEB === "1" ? await webProxy() : "";
type Result = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};
type Call = {
  digest: string;
  pid?: number;
  state: "running" | "done";
  result?: Result;
  preview?: { stdout: string; stderr: string };
};
const calls = new Map<string, Call>();
const idSchema = type(/^([a-f0-9]{64})$/),
  cmd = type({
    id: idSchema,
    boot: "string",
    command: "1 <= string <= 8192",
    "+": "reject",
  });
function kill(pid?: number) {
  if (pid)
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
}
function start(command: string, digest: string): Call {
  const entry: Call = {
    state: "running",
    digest,
    preview: { stdout: "", stderr: "" },
  };
  const child = spawn(guard, [workspace, command], {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: workspace,
      LANG: "C.UTF-8",
      TMPDIR: workspace + "/.tmp",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      ...(proxy
        ? {
            PI_EGRESS_SOCKET: proxy,
            ALL_PROXY: "socks5h://localhost" + proxy,
            all_proxy: "socks5h://localhost" + proxy,
          }
        : {}),
    },
  });
  entry.pid = child.pid;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    kill(entry.pid);
  }, 30000);
  const result: Result = {
    stdout: "",
    stderr: "",
    exitCode: 126,
    timedOut: false,
  };
  for (const name of ["stdout", "stderr"] as const) {
    let buf: Buffer = Buffer.alloc(0),
      size = 0;
    child[name].on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (buf.length < 16384) {
        buf = Buffer.concat([buf, chunk.subarray(0, 16384 - buf.length)]);
        if (entry.preview)
          entry.preview[name] = buf.subarray(0, 4096).toString();
      }
      result[name] = buf.toString() + (size > 16384 ? "\n[truncated]" : "");
    });
  }
  child.on("error", () => {
    result.stderr = "command unavailable; outcome unknown";
  });
  child.once("exit", () => {
    kill(entry.pid);
    delete entry.pid;
  });
  child.once("close", (code) => {
    clearTimeout(deadline);
    entry.state = "done";
    entry.result = { ...result, exitCode: code ?? 130, timedOut };
    delete entry.pid;
    delete entry.preview;
  });
  return entry;
}
const busy = () => [...calls.values()].some((c) => c.state === "running");
http
  .createServer(
    { requestTimeout: 6000, headersTimeout: 6000 },
    async (req, res) => {
      const send = (code: number, x: unknown = {}) =>
        res
          .writeHead(code, {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          .end(JSON.stringify(x));
      try {
        const h = Buffer.from(req.headers.authorization ?? "");
        if (h.length !== expected.length || !timingSafeEqual(h, expected))
          return void send(403);
        if (req.url === "/health" && ["GET", "POST"].includes(req.method ?? ""))
          return void send(200, { boot, active: Number(busy()) });
        if (
          req.method !== "POST" ||
          !["/cmd", "/get", "/cancel"].includes(req.url ?? "")
        )
          return void send(404);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const b of req) {
          size += b.length;
          if (size > 65536) return void send(413);
          chunks.push(b);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!body || typeof body !== "object" || !("id" in body))
          return void send(400);
        const id = idSchema.assert(body.id);
        let e = calls.get(id);
        if (req.url === "/cmd") {
          const data = cmd.assert(body);
          if (data.boot !== boot) return void send(409, { state: "stale" });
          const digest = createHash("sha256")
            .update(data.command)
            .digest("hex");
          if (e && e.digest !== digest)
            return void send(409, { state: "conflict" });
          if (!e) {
            if (busy()) return void send(409, { state: "busy" });
            if (calls.size >= 128) calls.delete(calls.keys().next().value!);
            e = start(data.command, digest);
            calls.set(id, e);
          }
        } else if (req.url === "/cancel") kill(e?.pid);
        send(
          200,
          e
            ? { state: e.state, preview: e.preview, result: e.result }
            : { state: "missing" },
        );
      } catch {
        send(400);
      }
    },
  )
  .listen(Number(process.env.PORT ?? 8282), process.env.BIND ?? "0.0.0.0", () =>
    console.log("ready"),
  );
