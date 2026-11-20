import { Client } from "pg";
import { database } from "../persistence/pg/database.ts";
import { sql } from "kysely";
import { runtime } from "../conversations/service.ts";
import { setTimeout as sleep } from "node:timers/promises";
async function start() {
  const pg = new Client({
    connectionString: process.env.DATABASE_URL,
    keepAlive: true,
  });
  pg.on("error", () => process.exit(1));
  await pg.connect();
  const db = database(pg);
  while (
    !(
      await sql<{
        active: boolean;
      }>`select pg_try_advisory_lock(742037391) as active`.execute(db)
    ).rows[0].active
  )
    await sleep(400);
  const app = await runtime(
    db,
    process.env.MODEL_BASE_URL!,
    process.env.MODEL_ID,
  );
  return { db, app };
}
let pending: ReturnType<typeof start> | undefined;
export const service = () =>
  (pending ??= start().catch((e) => {
    console.error("writer startup failed");
    process.exit(1);
  }));
