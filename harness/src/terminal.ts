import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { Database } from "./database.ts";
import { sql } from "kysely";
import { permissions, type Identity } from "./auth.ts";
const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
type Grants = { volume: boolean };
type Lease = { uid: string; url: string; key: string };
export async function terminalAdapter(db: Database) {
  const url = new URL("/v1/lifecycle", process.env.CONTROLLER_URL!),
    key = process.env.CONTROLLER_KEY;
  if (!key || key.length < 32) throw Error("controller credential required");
  await sql`CREATE TABLE IF NOT EXISTS pi_call (id text PRIMARY KEY,cid bigint NOT NULL,digest text NOT NULL,pod text NOT NULL,boot text NOT NULL,result jsonb)`.execute(
    db,
  );
  const turns = new Map<number, Identity>(),
    locks = new Map<string, Promise<unknown>>();
  async function serial<T>(owner: string, f: () => Promise<T>) {
    const p = (locks.get(owner) ?? Promise.resolve()).catch(() => {}).then(f);
    locks.set(owner, p);
    try {
      return await p;
    } finally {
      if (locks.get(owner) === p) locks.delete(owner);
    }
  }
  async function lifecycle(
    action: string,
    owner: string,
    id: string,
    grants?: Grants,
    uid?: string,
  ) {
    const r = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, owner, id, grants, uid }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw Error("sandbox controller unavailable");
    return r.json();
  }
  async function rpc(p: Lease, path: string, data?: object) {
    const r = await fetch(new URL("/" + path, p.url), {
      method: data ? "POST" : "GET",
      redirect: "error",
      headers: {
        authorization: "Bearer " + p.key,
        "content-type": "application/json",
      },
      body: data && JSON.stringify(data),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) throw Error("sandbox unavailable");
    return r.json();
  }
  async function grants(who: Identity, id: string) {
    const g = who.expires > Date.now() ? await permissions(who.token) : null;
    if (!g) {
      await lifecycle("fence", who.owner, id);
      throw Error("sandbox not authorized");
    }
    return g;
  }
  async function prepare(
    action: "warm" | "acquire",
    who: Identity,
    id: string,
    signal?: AbortSignal,
  ) {
    let prior = "";
    for (const end = Date.now() + 120000; Date.now() < end; ) {
      signal?.throwIfAborted();
      const g = await grants(who, id);
      const current = JSON.stringify(g);
      const lease = await lifecycle(action, who.owner, id, g);
      if (!lease.pending) {
        if (action === "warm") return lease;
        const fresh = await grants(who, id);
        if (JSON.stringify(fresh) === current) return lease;
        await lifecycle("release", who.owner, id, undefined, lease.uid);
      }
      await wait(prior === current ? 500 : 100);
      prior = current;
    }
    throw Error("sandbox not ready");
  }
  const active = new Map<number, { p: Lease; id: string }>();
  const tool = defineTool({
    name: "cmd",
    description:
      "Run a bounded shell command in the authorized sandbox. Never repeat a command with an unknown outcome.",
    parameters: obj({ command: str() }),
    replay: "safe",
    execute: async ({ command }, api, ctx) => {
      if (!command || command.length > 8192) throw Error("invalid command");
      const cid = Number(api.conversationId),
        id = hash([cid, api.taskId, api.callId]),
        digest = hash(command);
      const owner = (
        await db
          .selectFrom("pi_owner")
          .select("owner")
          .where("cid", "=", cid)
          .executeTakeFirst()
      )?.owner;
      if (!owner) throw Error("owner unavailable");
      await api.details({ phase: "queued" }, ctx);
      const result = await serial(owner, async () => {
        const row = await db
          .selectFrom("pi_call")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        if (row && row.digest !== digest) throw Error("conflicting call");
        if (row?.result) return row.result;
        let p: Lease | undefined;
        const unknown = {
          state: "unknown",
          stderr: "Outcome unknown. Do not repeat this command.",
        };
        let answer: any = unknown;
        try {
          let state;
          if (row) {
            const existing = await lifecycle(
              "lookup",
              owner,
              id,
              undefined,
              row.pod,
            );
            if (!existing.missing) p = existing;
          } else {
            const who = turns.get(cid);
            if (who?.owner !== owner || !who)
              throw Error("original authorization unavailable");
            await api.details({ phase: "preparing" }, ctx);
            p = await prepare("acquire", who, id, ctx.abortSignal);
          }
          if (p) {
            const health = await rpc(p, "health");
            if (!row || row.boot === health.boot) {
              if (!row) {
                const who = turns.get(cid)!;
                const g = await grants(who, id);
                const checked = await lifecycle("check", owner, id, g, p.uid);
                if (!checked.valid)
                  throw Error("sandbox configuration changed before dispatch");
                ctx.abortSignal?.throwIfAborted();
                await db
                  .insertInto("pi_call")
                  .values({
                    id,
                    cid,
                    digest,
                    pod: p.uid,
                    boot: health.boot,
                    result: null,
                  })
                  .execute();
                try {
                  state = await rpc(p, "cmd", {
                    id,
                    command,
                    boot: health.boot,
                  });
                } catch {
                  /* never resend */
                }
              }
              active.set(cid, { p, id });
              let last = "";
              for (const end = Date.now() + 38000; Date.now() < end; ) {
                ctx.abortSignal?.throwIfAborted();
                if (state?.state === "done") {
                  answer = state.result;
                  break;
                }
                if (state?.state === "missing") break;
                if (
                  state?.state === "running" &&
                  JSON.stringify(state.preview ?? {}) !== last
                ) {
                  last = JSON.stringify(state.preview ?? {});
                  await api.details(
                    { phase: "running", ...state.preview },
                    ctx,
                  );
                }
                await wait(100);
                try {
                  state = await rpc(p, "get", { id });
                } catch {
                  state = null;
                }
              }
            }
          }
          await db
            .updateTable("pi_call")
            .set({ result: JSON.stringify(answer) })
            .where("id", "=", id)
            .execute();
          return answer;
        } finally {
          active.delete(cid);
          if (p)
            await lifecycle("release", owner, id, undefined, p.uid).catch(
              () => {},
            );
        }
      });
      return {
        details: null,
        isError: result.state === "unknown" || result.exitCode !== 0,
        output: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });
  return {
    extension: defineExtension({ name: "sandbox", tools: [tool] }),
    authorizeTurn(cid: number, who: Identity) {
      turns.set(cid, who);
    },
    warm(cid: number, id: string) {
      const who = turns.get(cid);
      if (who)
        void serial(who.owner, () => prepare("warm", who, id)).catch(() => {});
    },
    clear(cid: number, who: Identity) {
      if (turns.get(cid) === who) turns.delete(cid);
    },
    async cancel(cid: number) {
      const a = active.get(cid);
      if (a) await rpc(a.p, "cancel", { id: a.id }).catch(() => {});
    },
    close() {
      turns.clear();
    },
  };
}
