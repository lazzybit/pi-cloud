import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

export type Caller = { owner: string; token: string; expires: number };
export type Grants = { volume: boolean };
export type Endpoint = { uid: string; url: string; key: string };
export type Output = { stdout: string; stderr: string };
export type Result = (Output & { exitCode: number; timedOut: boolean }) | { state: "unknown"; stderr: string };
export type Observation = { state: "done"; result: Exclude<Result, { state: "unknown" }> } | { state: "running"; preview: Output } | { state: "missing" };
export type Intent = { id: string; cid: number; digest: string; pod: string; boot: string; result: Result | null };
export interface CallLedger {
  owner(cid: number): Promise<string | undefined>;
  find(id: string): Promise<Intent | undefined>;
  record(intent: Intent): Promise<void>;
  finish(id: string, result: Result): Promise<void>;
}
export interface Lifecycle {
  warm(owner: string, id: string, grants: Grants): Promise<boolean>;
  acquire(owner: string, id: string, grants: Grants): Promise<Endpoint | undefined>;
  validate(owner: string, id: string, grants: Grants, uid: string, boot: string, digest: string): Promise<string | undefined>;
  lookup(owner: string, id: string, uid: string): Promise<Endpoint | undefined>;
  release(owner: string, id: string, uid: string): Promise<void>;
  fence(owner: string, id: string): Promise<void>;
}
export interface Worker {
  health(p: Endpoint): Promise<string>;
  start(p: Endpoint, id: string, boot: string, command: string, ticket: string): Promise<Observation>;
  observe(p: Endpoint, id: string, boot: string): Promise<Observation>;
  cancel(p: Endpoint, id: string, boot: string): Promise<void>;
}
type Input = { cid: number; id: string; command: string; signal?: AbortSignal; progress?: (details: { phase: string } & Partial<Output>) => Promise<void> };
type Active = { endpoint: Endpoint; id: string; boot: string };
type Dependencies = { ledger: CallLedger; lifecycle: Lifecycle; worker: Worker; grants(token: string): Promise<Grants | null>; pollMs?: number };
const unknown: Result = { state: "unknown", stderr: "Outcome unknown. Do not repeat this command." };
export const commandDigest = (command: string) => createHash("sha256").update(command, "utf8").digest("hex");

export class CmdExecutor {
  private turns = new Map<number, Caller>();
  private queues = new Map<string, Promise<unknown>>();
  private active = new Map<number, Active>();
  constructor(private deps: Dependencies) {}

  authorizeTurn(cid: number, who: Caller) { this.turns.set(cid, who); }
  clear(cid: number, who: Caller) { if (this.turns.get(cid) === who) this.turns.delete(cid); }
  close() { this.turns.clear(); }
  async cancel(cid: number) {
    const a = this.active.get(cid);
    if (a) await this.cancelCall(a);
  }
  warm(cid: number, id: string) {
    const who = this.turns.get(cid);
    if (who) void this.serialize(who.owner, async () => {
      for (const until = performance.now() + 120000; performance.now() < until && this.turns.get(cid) === who;) {
        const grants = await this.requireGrants(who, id);
        if (await this.deps.lifecycle.warm(who.owner, id, grants)) return;
        await wait(500);
      }
    }).catch(() => {});
  }
  async execute(input: Input): Promise<Result> {
    const { cid, command } = input;
    if (!command || !command.isWellFormed() || command.includes("\0") || Buffer.byteLength(command) > 8192) throw Error("invalid command");
    const owner = await this.deps.ledger.owner(cid);
    if (!owner) throw Error("owner unavailable");
    await input.progress?.({phase: "queued"});
    return this.serialize(owner, () => this.dispatch(input, owner, commandDigest(command)));
  }

  private async dispatch(input: Input, owner: string, digest: string): Promise<Result> {
    const { cid, id, command, signal, progress } = input;
    const { ledger, lifecycle, worker } = this.deps;
    signal?.throwIfAborted();
    const existing = await ledger.find(id);
    if (existing && (existing.digest !== digest || existing.cid !== cid)) throw Error("conflicting call");
    if (existing?.result) return existing.result;
    let endpoint: Endpoint | undefined;
    let active: Active | undefined;
    try {
      let first: Observation | undefined;
      let boot: string;
      if (existing) {
        endpoint = await lifecycle.lookup(owner, id, existing.pod);
        if (!endpoint || endpoint.uid !== existing.pod) {
          await ledger.finish(id, unknown);
          return unknown;
        }
        boot = existing.boot;
      } else {
        const who = this.turns.get(cid);
        if (!who || who.owner !== owner) throw Error("original authorization unavailable");
        await progress?.({phase: "preparing"});
        const until = performance.now() + 120000;
        let ticket: string | undefined;
        for (;;) {
          signal?.throwIfAborted();
          if (performance.now() >= until) throw Error("sandbox not ready");
          const before = await this.requireGrants(who, id);
          endpoint = await lifecycle.acquire(owner, id, before);
          if (!endpoint) { await wait(500, undefined, { signal }); continue; }
          boot = await worker.health(endpoint);
          const fresh = await this.requireGrants(who, id);
          if (fresh.volume === before.volume) {
            ticket = await lifecycle.validate(owner, id, fresh, endpoint.uid, boot, digest);
            if (ticket) break;
          }
          await lifecycle.release(owner, id, endpoint.uid);
          endpoint = undefined;
          await wait(100, undefined, { signal });
        }
        signal?.throwIfAborted();
        await ledger.record({ id, cid, digest, pod: endpoint.uid, boot, result: null });
        if (!signal?.aborted) {
          active = { endpoint, id, boot };
          this.active.set(cid, active);
          // Once recorded, try start at most once. A lost reply goes to observe.
          first = await worker.start(endpoint, id, boot, command, ticket).catch(() => undefined);
        }
      }
      active ??= { endpoint, id, boot };
      this.active.set(cid, active);
      const result = await this.observe(active, input, first);
      await ledger.finish(id, result);
      return result;
    } finally {
      if (active && signal?.aborted) await this.cancelCall(active);
      this.active.delete(cid);
      if (endpoint) await lifecycle.release(owner, id, endpoint.uid).catch(() => {});
    }
  }

  private async observe(active: Active, input: Input, current?: Observation): Promise<Result> {
    const { signal, progress } = input;
    let last = "";
    for (const end = performance.now() + 38000; performance.now() < end;) {
      signal?.throwIfAborted();
      if (!current) current = await this.deps.worker.observe(active.endpoint, active.id, active.boot).catch(() => undefined);
      if (current?.state === "done") return current.result;
      if (current?.state === "missing") return unknown;
      if (current?.state === "running") {
        const next = JSON.stringify(current.preview);
        if (next !== last) await progress?.({ phase: "running", ...current.preview });
        last = next;
      }
      current = undefined;
      await wait(this.deps.pollMs ?? 100, undefined, { signal });
    }
    return unknown;
  }
  private async requireGrants(who: Caller, id: string) {
    const grants = who.expires > Date.now() ? await this.deps.grants(who.token) : null;
    if (grants && who.expires > Date.now()) return grants;
    await this.deps.lifecycle.fence(who.owner, id);
    throw Error("sandbox not authorized");
  }
  private async cancelCall(a: Active) {
    await this.deps.worker.cancel(a.endpoint, a.id, a.boot).catch(() => {});
  }
  private async serialize<T>(owner: string, run: () => Promise<T>) {
    const op = (this.queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(owner, op);
    try { return await op; }
    finally { if (this.queues.get(owner) === op) this.queues.delete(owner); }
  }
}
