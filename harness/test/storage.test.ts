import { it, expect, beforeAll, afterAll } from "vitest";
import PG from "embedded-postgres";
import { Client } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database } from "../src/persistence/pg/database.ts";
import { runtime } from "../src/conversations/service.ts";
let pg: PG, client: Client, dir: string;
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
it("conversation IDs and order survive a fresh harness, without contacting a provider", async () => {
  const start = () =>
    runtime(database(client), "http://127.0.0.1:1/v1", "unused");
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
  const writer = await runtime(database(client), "http://localhost:1/v1", "unused");
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
it("offers and validates the configured model's thinking levels", async () => {
  const app = await runtime(
    database(client), "http://localhost:1/v1", "gpt-5.2", "gpt-4.1-mini,fixture-alt",
  );
  try {
    const { id } = await app.create("subject-a");
    const watch = app.watch(id);
    try {
      expect((await watch.next()).value?.models).toEqual([
        { id: "gpt-5.2", efforts: ["default", "low", "medium", "high", "xhigh"] },
        { id: "gpt-4.1-mini", efforts: ["default"] },
        { id: "fixture-alt", efforts: ["default", "low", "medium", "high"] },
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
