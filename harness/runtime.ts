import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { RpcError } from "./errors.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "./database.ts";
import { sql } from "kysely";
import { PgStorage } from "./storage.ts";
import { terminalAdapter } from "./terminal.ts";
import { transcript } from "./transcript.ts";
import { gateway } from "./provider.ts";
import type { Snapshot, Settings } from "./schema.ts";
export async function runtime(
  db: Database,
  baseUrl: string,
  model: string,
  extraModels = "",
) {
  const models = [
    ...new Set([
      model,
      ...extraModels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ];
  const store = new PgStorage(db);
  await store.recover();
  const registry = createRegistry();
  const terminal = process.env.CONTROLLER_URL
    ? await terminalAdapter(db)
    : undefined;
  if (terminal) registry.install(terminal.extension);
  const h = await Harness.open(
    store,
    { models: gateway(baseUrl, models), registry },
    c,
  );
  await sql`CREATE TABLE IF NOT EXISTS pi_requests (cid bigint, request uuid, prompt text NOT NULL, primary key(cid,request))`.execute(
    db,
  );
  await sql`CREATE TABLE IF NOT EXISTS pi_owner (cid bigint PRIMARY KEY, owner text NOT NULL); CREATE INDEX IF NOT EXISTS pi_owner_list ON pi_owner(owner,cid)`.execute(
    db,
  );
  h.resume();
  const conv = async (id: number) => {
    const v = await h.conversation(id as ConversationId, c);
    if (!v) throw new RpcError("NOT_FOUND");
    return v;
  };
  let gate = Promise.resolve();
  function exclusive<T>(f: () => Promise<T>) {
    const op = gate.then(f);
    gate = op.then(
      () => {},
      () => {},
    );
    return op;
  }
  const latest = async (id: ConversationId) =>
    (
      await store.scanSubmissions(
        { conversationId: id, order: "descending" },
        1,
        undefined,
        c,
      )
    ).items[0];
  return {
    close: () => {
      terminal?.close();
      return h.close(c);
    },
    create: async (owner: string) => {
      const id = (
        await h.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { model: { provider: "agentgateway", modelId: model } },
          },
          c,
        )
      ).id;
      await db.insertInto("pi_owner").values({ cid: id, owner }).execute();
      return { id };
    },
    async list(owner: string) {
      return (
        await db
          .selectFrom("pi_owner")
          .select("cid")
          .where("owner", "=", owner)
          .orderBy("cid")
          .execute()
      ).map((r) => Number(r.cid));
    },
    async owned(owner: string, id: number) {
      if (
        !(await db
          .selectFrom("pi_owner")
          .select("cid")
          .where("owner", "=", owner)
          .where("cid", "=", id)
          .executeTakeFirst())
      )
        throw Object.assign(new Response(null, { status: 404 }), {
          code: "NOT_FOUND",
        });
    },
    async configure(id: number, settings: Settings) {
      if (!models.includes(settings.model))
        throw new RpcError("BAD_REQUEST", { message: "Unknown model" });
      const v = await conv(id);
      return exclusive(async () => {
        const t = await latest(v.id);
        if (t && ["placed", "queued"].includes(t.status))
          throw new RpcError("CONFLICT", { message: "busy" });
        await v.configure(
          {
            model: { provider: "agentgateway", modelId: settings.model },
            thinkingLevel:
              settings.effort === "default" ? null : settings.effort,
          },
          c,
        );
        return settings;
      });
    },
    async send(
      id: number,
      requestId: string,
      text: string,
      identity: import("./auth.ts").Identity,
    ) {
      const v = await conv(id);
      const sub = await exclusive(async () => {
        const prev = await store.submissionByRequest(v.id, requestId, c);
        const last = await latest(v.id);
        if (!prev && last && ["queued", "placed"].includes(last.status))
          throw new RpcError("CONFLICT", { message: "busy" });
        const same = await db
          .insertInto("pi_requests")
          .values({ cid: id, request: requestId, prompt: text })
          .onConflict((o) =>
            o
              .columns(["cid", "request"])
              .doUpdateSet({ prompt: text })
              .where("pi_requests.prompt", "=", text),
          )
          .returning("request")
          .executeTakeFirst();
        if (!same)
          throw new RpcError("CONFLICT", {
            message: "request payload changed",
          });
        if (!prev) terminal?.authorizeTurn(id, identity);
        const submission = await v.submit(
          { type: "input", content: text, requestId },
          c,
        );
        if (!prev) terminal?.warm(id, requestId);
        return submission;
      });
      try {
        return { status: (await sub.wait(c)).status };
      } finally {
        terminal?.clear(id, identity);
      }
    },
    async stop(id: number, requestId: string) {
      const v = await conv(id);
      return exclusive(async () => {
        const t = await latest(v.id);
        if (
          t?.requestId !== requestId ||
          !["placed", "queued"].includes(t.status)
        )
          return false;
        await v.abort(c);
        await terminal?.cancel(id);
        return true;
      });
    },
    async *watch(id: number, signal?: AbortSignal) {
      const v = await conv(id);
      const view = await v.watch(c);
      let value = view.value;
      view.start(async (call) => {
        if (call.kind === "value") value = call.value;
      });
      let prev = "";
      try {
        while (!signal?.aborted) {
          const t = await latest(v.id);
          const { messages, partial } = transcript(value);
          const state: Snapshot["state"] = !t
            ? "idle"
            : t.status === "done"
              ? "done"
              : t.status === "unanswered"
                ? t.reason.includes("abort")
                  ? "stopped"
                  : "failed"
                : "running";
          const agent = value.docs["pi.agent"] as
            | {
                model?: { modelId: string };
                thinkingLevel?: "low" | "medium" | "high" | "off";
              }
            | undefined;
          const settings: Settings = {
            model: agent?.model?.modelId ?? model,
            effort:
              !agent?.thinkingLevel || agent.thinkingLevel === "off"
                ? "default"
                : agent.thinkingLevel,
          };
          const s = {
            models,
            settings,
            id,
            messages,
            partial,
            turn: t?.requestId ?? null,
            state,
          };
          const key = JSON.stringify(s);
          if (key !== prev) {
            prev = key;
            yield s;
          }
          await sleep(100, undefined, { signal });
        }
      } finally {
        await view.stop();
      }
    },
  };
}
