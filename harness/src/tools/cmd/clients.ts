import type { Endpoint, Lifecycle, Worker } from "./executor.ts";

async function request(url: URL, key: string, timeout: number, body?: object): Promise<unknown> {
  const r = await fetch(url, {
    method: body ? "POST" : "GET", redirect: "error",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok && r.status !== 409) throw Error("sandbox endpoint unavailable");
  return r.json();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid sandbox response");
  return value as Record<string, unknown>;
}
function endpoint(value: Record<string, unknown>): Endpoint {
  const { uid, url, key } = value;
  if (typeof uid !== "string" || !uid || typeof url !== "string" || typeof key !== "string" || key.length < 32) throw Error("invalid sandbox endpoint");
  return { uid, url, key };
}
export function lifecycleClient(base: string, key: string): Lifecycle {
  const url = new URL("/v1/lifecycle", base);
  const call = async (body: object) => record(await request(url, key, 12000, body));
  return {
    warm: async (owner, id, grants) => (await call({ action: "warm", owner, id, grants })).ready === true,
    async acquire(owner, id, grants) {
      const data = await call({ action: "acquire", owner, id, grants });
      if (data.pending !== true) return endpoint(data);
    },
    async validate(owner, id, grants, uid, boot, digest) {
      const data = await call({ action: "check", owner, id, grants, uid, boot, digest });
      if (data.valid === true && typeof data.ticket === "string") return data.ticket;
    },
    async lookup(owner, id, uid) {
      const data = await call({ action: "lookup", owner, id, uid });
      if (data.missing !== true) return endpoint(data);
    },
    async release(owner, id, uid) { await call({ action: "release", owner, id, uid }); },
    async fence(owner, id) { await call({ action: "fence", owner, id }); },
  };
}
function output(value: unknown) {
  const { stdout, stderr } = record(value);
  if (typeof stdout !== "string" || typeof stderr !== "string") throw Error("invalid sandbox output");
  return { stdout, stderr };
}
function observation(value: unknown): Awaited<ReturnType<Worker["observe"]>> {
  const data = record(value);
  if (data.state === "missing" || data.state === "stale") return { state: "missing" };
  if (data.state === "running") return { state: "running", preview: output(data.preview) };
  if (data.state === "done") {
    const result = record(data.result);
    if (typeof result.exitCode === "number" && Number.isInteger(result.exitCode) && typeof result.timedOut === "boolean") {
      return { state: "done", result: { ...output(result), exitCode: result.exitCode, timedOut: result.timedOut } };
    }
  }
  throw Error("invalid sandbox observation");
}
export function workerClient(): Worker {
  const call = (p: Endpoint, path: string, data?: object) => request(new URL(path, p.url), p.key, 2500, data);
  return {
    async health(p) {
      const { boot } = record(await call(p, "/health"));
      if (typeof boot !== "string" || !boot) throw Error("invalid sandbox boot");
      return boot;
    },
    start: async (p, id, boot, command, ticket) => observation(await call(p, "/cmd", { id, boot, command, ticket })),
    observe: async (p, id, boot) => observation(await call(p, "/get", { id, boot })),
    async cancel(p, id, boot) { await call(p, "/cancel", { id, boot }); },
  };
}
