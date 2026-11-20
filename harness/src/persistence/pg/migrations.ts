import { sql } from "kysely";
import type { Database } from "./database.ts";

export async function migrateSession(db: Database) {
  await db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(742037392)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS pi_session (id text PRIMARY KEY, sealed text NOT NULL, expires bigint NOT NULL)`.execute(tx);
  });
}

const writerMigrations = [async (db: Database) => {
  await sql`CREATE TABLE IF NOT EXISTS pi_journal (seq bigint generated always as identity primary key, batches bytea not null)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS pi_owner (cid bigint PRIMARY KEY, owner text NOT NULL); CREATE INDEX IF NOT EXISTS pi_owner_list ON pi_owner(owner,cid)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS pi_requests (cid bigint, request uuid, prompt text NOT NULL, primary key(cid,request))`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS pi_call (id text PRIMARY KEY,cid bigint NOT NULL,digest text NOT NULL,pod text NOT NULL,boot text NOT NULL,result jsonb)`.execute(db);
}];
export async function migrateWriter(db: Database) {
  await sql`CREATE TABLE IF NOT EXISTS pi_schema (version int PRIMARY KEY)`.execute(db);
  for (const [index, migrate] of writerMigrations.entries()) {
    const version = index + 1;
    await db.transaction().execute(async (tx) => {
      if ((await sql`select version from pi_schema where version = ${version}`.execute(tx)).rows.length) return;
      await migrate(tx);
      await sql`insert into pi_schema(version) values (${version})`.execute(tx);
    });
  }
}
