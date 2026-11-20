import { it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import PG from "embedded-postgres";
import { Client } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database } from "../src/persistence/pg/database.ts";
import { runtime } from "../src/conversations/service.ts";
let pg: PG, client: Client, dir: string;
const gatewayUrl = "http://localhost:1/v1";
const listModels = vi.fn();
beforeEach(() => {
  listModels.mockReset().mockImplementation(() => Response.json({ data: [
    { id: "unused", reasoningEfforts: [{ value: "high" }] },
    { id: "gpt-5.2" },
    { id: "gpt-4.1-mini" },
    { id: "fixture-alt", reasoningEfforts: [{ value: "low" }, { value: "xhigh" }] },
    { id: "fixture-alt" },
  ] }));
  vi.stubGlobal("fetch", listModels);
});
afterEach(() => vi.unstubAllGlobals());
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-vitest-"));
  pg = new PG({
    databaseDir: dir,
    port: 35324,
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  client = new Client({
    port: 35324,
    host: "127.0.0.1",
    database: "postgres",
    user: "postgres",
    password: "password",
  });
  await client.connect();
}, 30000);
afterAll(async () => {
  await client?.end();
  await pg?.stop();
  await rm(dir, { force: true, recursive: true });
});
it("conversation IDs and order survive a fresh harness", async () => {
  const start = () =>
    runtime(database(client), gatewayUrl, "unused");
  const a = await start();
  const first = await a.create("subject-a");
  await a.configure(first.id, { model: "unused", effort: "high" });
  await a.close();
  const b = await start();
  const watch = b.watch(first.id);
  expect((await watch.next()).value?.settings).toEqual({
    model: "unused",
    effort: "high",
  });
  await watch.return();
  await expect(
    b.configure(first.id, { model: "other", effort: "low" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await b.list("subject-a")).toEqual([first.id]);
  expect(await b.list("subject-b")).toEqual([]);
  await expect(
    b.requireConversationOwner("subject-b", first.id),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const second = await b.create("subject-b");
  expect(second.id).toBeGreaterThan(first.id);
  await b.close();
});
it("does not commit a conversation if its owner index cannot be written", async () => {
  const writer = await runtime(database(client), gatewayUrl, "unused");
  const before = (await client.query("SELECT count(*) FROM pi_journal")).rows[0].count;
  await client.query("ALTER TABLE pi_owner ADD CONSTRAINT owner_fixture CHECK (owner <> 'fixture-rejected')");
  try {
    await expect(writer.create("fixture-rejected")).rejects.toThrow();
    expect((await client.query("SELECT count(*) FROM pi_journal")).rows[0].count).toBe(before);
  } finally {
    await client.query("ALTER TABLE pi_owner DROP CONSTRAINT owner_fixture");
    await writer.close();
  }
});
it("lists only gateway models and validates their thinking levels", async () => {
  const app = await runtime(database(client), gatewayUrl + "/", "gpt-5.2");
  try {
    expect(listModels).toHaveBeenCalledWith(gatewayUrl + "/models", expect.anything());
    const { id } = await app.create("subject-a");
    const watch = app.watch(id);
    try {
      expect((await watch.next()).value?.models).toEqual([
        { id: "unused", efforts: ["default", "high"] },
        { id: "gpt-5.2", efforts: ["default", "low", "medium", "high", "xhigh"] },
        { id: "gpt-4.1-mini", efforts: ["default"] },
        { id: "fixture-alt", efforts: ["default", "low", "xhigh"] },
      ]);
    } finally {
      await watch.return();
    }
    await expect(app.configure(id, { model: "gpt-4.1-mini", effort: "high" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(app.configure(id, { model: "gpt-5.2", effort: "xhigh" }))
      .resolves.toEqual({ model: "gpt-5.2", effort: "xhigh" });
  } finally {
    await app.close();
  }
});
it("uses a discovered default when the preferred model is no longer listed", async () => {
  const app = await runtime(database(client), gatewayUrl, "retired");
  try {
    const { id } = await app.create("subject-a");
    const watch = app.watch(id);
    try {
      expect((await watch.next()).value?.settings).toEqual({ model: "unused", effort: "default" });
    } finally {
      await watch.return();
    }
  } finally {
    await app.close();
  }
});
it("refreshes the live catalog without changing a conversation's selected model", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const app = await runtime(database(client), gatewayUrl, "unused");
    try {
      const { id } = await app.create("subject-a");
      const watch = app.watch(id);
      try {
        expect((await watch.next()).value?.settings.model).toBe("unused");
        listModels.mockImplementationOnce(() => new Response(null, { status: 503 }));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(warning).toHaveBeenCalledOnce();
        await expect(app.configure(id, { model: "unused", effort: "high" })).resolves.toBeDefined();
        listModels.mockImplementationOnce(() => Response.json({ data: [{ id: "new-alias" }] }));
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await watch.next()).value).toMatchObject({
          models: [{ id: "new-alias", efforts: ["default"] }],
          settings: { model: "unused", effort: "high" },
        });
        await expect(app.send(id, "test-request", "test input", {
          owner: "subject-a", token: "fixture", expires: Date.now() + 1000,
        })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Model is not listed by agentgateway" });
        await expect(app.configure(id, { model: "new-alias", effort: "default" })).resolves.toBeDefined();
      } finally {
        await watch.return();
      }
    } finally {
      await app.close();
    }
  } finally {
    warning.mockRestore();
    vi.useRealTimers();
  }
});
it("another PostgreSQL session cannot own the same storage", async () => {
  const other = new Client({
    port: 35324,
    host: "127.0.0.1",
    database: "postgres",
    user: "postgres",
    password: "password",
  });
  await other.connect();
  try {
    await client.query("SELECT pg_advisory_lock(742037391)");
    expect(
      (await other.query("SELECT pg_try_advisory_lock(742037391) AS ok"))
        .rows[0].ok,
    ).toBe(false);
  } finally {
    await client.query("SELECT pg_advisory_unlock(742037391)");
    await other.end();
  }
});
