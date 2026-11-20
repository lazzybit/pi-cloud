import { Harness, createRegistry, type ConversationId, type AgentState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { RpcError } from "./errors.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "../persistence/pg/database.ts";
import { migrateWriter } from "../persistence/pg/migrations.ts";
import { productOwner } from "./ownership.ts";
import { PgStorage } from "../persistence/pg/storage.ts";
import { terminalAdapter } from "../tools/cmd/tool.ts";
import { codeMode } from "../tools/codemode.ts";
import { transcript } from "./projection/transcript.ts";
import { gateway } from "../agent/provider.ts";
import type { Snapshot, Settings } from "../web/schema.ts";
export async function runtime(
  db: Database,
  baseUrl: string,
  preferredModel?: string,
) {
  const catalog = gateway(baseUrl);
  await catalog.refresh();
  await migrateWriter(db);
  const store = new PgStorage(db);
  await store.recover();
  const registry = createRegistry();
  const cmd = process.env.CONTROLLER_URL
    ? terminalAdapter(db, process.env.CONTROLLER_URL, process.env.CONTROLLER_KEY!)
    : undefined;
  if (cmd) registry.install(cmd.extension);
  const scripts = cmd ? codeMode() : undefined;
  if (scripts) registry.install(scripts.extension);
  const terminal = cmd?.executor;
  const h = await Harness.open(
    store,
    { models: catalog.models, registry },
    c,
  );
  h.resume();
  const refresh = setInterval(() => {
    void catalog.refresh().catch(() => {
      console.warn("agentgateway model list refresh failed; keeping last list");
    });
  }, 60_000).unref();
  const defaultModel = () =>
    catalog.choices.find(({ id }) => id === preferredModel)?.id ?? catalog.choices[0]?.id;
  function requireSettings(model: string | undefined, effort: Settings["effort"]) {
    const selected = catalog.choices.find(({ id }) => id === model);
    if (!selected) throw new RpcError("BAD_REQUEST", { message: "Model is not listed by agentgateway" });
    if (!selected.efforts.includes(effort))
      throw new RpcError("BAD_REQUEST", { message: "Unsupported thinking level for this model" });
  }
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
    close: async () => {
      clearInterval(refresh);
      terminal?.close();
      try { await h.close(c); }
      finally { await scripts?.close(); }
    },
    create: async (owner: string) => {
      const model = defaultModel();
      if (!model) throw new RpcError("BAD_REQUEST", { message: "No models listed by agentgateway" });
      const id = (
        await h.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { model: { provider: "agentgateway", modelId: model } },
            async init(tx, id) { (await tx.doc(productOwner, id)).subject = owner; },
          },
          c,
        )
      ).id;
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
    async requireConversationOwner(owner: string, id: number) {
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
      const v = await conv(id);
      return exclusive(async () => {
        const t = await latest(v.id);
        if (t && ["placed", "queued"].includes(t.status))
          throw new RpcError("CONFLICT", { message: "busy" });
        requireSettings(settings.model, settings.effort);
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
      identity: import("../identity/auth.ts").Identity,
    ) {
      const v = await conv(id);
      const sub = await exclusive(async () => {
        const prev = await store.submissionByRequest(v.id, requestId, c);
        const last = await latest(v.id);
        if (!prev && last && ["queued", "placed"].includes(last.status))
          throw new RpcError("CONFLICT", { message: "busy" });
        if (!prev) {
          const { model, thinkingLevel } = await v.agent(c);
          requireSettings(model?.modelId, thinkingLevel === "off" ? "default" : thinkingLevel);
        }
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
        // A distinct context object is owned by this durable submission, not the RPC.
        const caller = prev ? undefined : { ...identity };
        if (caller) terminal?.authorizeTurn(id, caller);
        try {
          const submission = await v.submit({ type: "input", content: text, requestId }, c);
          if (caller && terminal) {
            terminal.warm(id, requestId);
            void submission.wait(c).catch(() => {}).finally(() => terminal.clear(id, caller));
          }
          return submission;
        } catch (error) {
          if (caller) terminal?.clear(id, caller);
          throw error;
        }
      });
      return { status: "accepted", requestId, submissionId: sub.id };
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
          const agent = value.docs["pi.agent"] as AgentState | undefined;
          const settings: Settings = {
            model: agent?.model?.modelId ?? "",
            effort:
              !agent?.thinkingLevel || agent.thinkingLevel === "off"
                ? "default"
                : agent.thinkingLevel,
          };
          const s = {
            models: catalog.choices,
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
