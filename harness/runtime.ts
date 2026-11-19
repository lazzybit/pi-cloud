import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { ORPCError } from "@orpc/server";
import { setTimeout as sleep } from "node:timers/promises";
import type { Client } from "pg";
import { PgStorage } from "./storage.ts";
import { terminalAdapter } from "./terminal.ts";
import { transcript } from "./transcript.ts";
import { gateway } from "./provider.ts";
import type { Snapshot, Settings } from "contract";
export async function runtime(
  db: Client,
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
  await db.query(
    "CREATE TABLE IF NOT EXISTS pi_requests (cid bigint, request uuid, prompt text NOT NULL, primary key(cid,request))",
  );
  await db.query(
    "CREATE TABLE IF NOT EXISTS pi_owner (cid bigint PRIMARY KEY, owner text NOT NULL); CREATE INDEX IF NOT EXISTS pi_owner_list ON pi_owner(owner,cid)",
  );
  h.resume();
  const conv = async (id: number) => {
    const v = await h.conversation(id as ConversationId, c);
    if (!v) throw new ORPCError("NOT_FOUND");
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
      await db.query("INSERT INTO pi_owner VALUES($1,$2)", [id, owner]);
      return { id };
    },
    async list(owner: string) {
      return (
        await db.query("SELECT cid FROM pi_owner WHERE owner=$1 ORDER BY cid", [
          owner,
        ])
      ).rows.map((r) => Number(r.cid));
    },
    async owned(owner: string, id: number) {
      if (
        !(
          await db.query("SELECT 1 FROM pi_owner WHERE owner=$1 AND cid=$2", [
            owner,
            id,
          ])
        ).rowCount
      )
        throw new ORPCError("NOT_FOUND");
    },
    async configure(id: number, settings: Settings) {
      if (!models.includes(settings.model))
        throw new ORPCError("BAD_REQUEST", { message: "Unknown model" });
      const v = await conv(id);
      return exclusive(async () => {
        const t = await latest(v.id);
        if (t && ["placed", "queued"].includes(t.status))
          throw new ORPCError("CONFLICT", { message: "busy" });
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
          throw new ORPCError("CONFLICT", { message: "busy" });
        const same = await db.query(
          "INSERT INTO pi_requests VALUES ($1,$2,$3) ON CONFLICT (cid,request) DO UPDATE SET prompt=pi_requests.prompt WHERE pi_requests.prompt=excluded.prompt RETURNING request",
          [id, requestId, text],
        );
        if (!same.rowCount)
          throw new ORPCError("CONFLICT", {
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
