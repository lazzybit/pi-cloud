import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Database } from "./database.ts";
import { sql } from "kysely";
import { serialize, deserialize } from "node:v8";

// PG is authoritative. Validate on a private staging index; publish receipts and
// advance the readable index only after PG has durably accepted the entire prefix.
export class PgStorage extends MemoryStorage {
  private stage = new MemoryStorage();
  private queue = Promise.resolve();
  private poisoned = false;
  constructor(private db: Database) {
    super();
  }
  async recover() {
    await sql`CREATE TABLE IF NOT EXISTS pi_journal (seq bigint generated always as identity primary key, batches bytea not null)`.execute(
      this.db,
    );
    let after = "0";
    for (;;) {
      const rows = await this.db
        .selectFrom("pi_journal")
        .selectAll()
        .where("seq", ">", after)
        .orderBy("seq")
        .limit(128)
        .execute();
      if (!rows.length) break;
      for (const r of rows) {
        const b = deserialize(r.batches);
        for (const m of [this.stage, this]) {
          const result = await MemoryStorage.prototype.commit.call(
            m,
            b,
            () => {},
            ctx,
          );
          if (result.stored !== b.length)
            throw Error("invalid durable journal");
        }
        after = r.seq;
      }
    }
  }
  override commit(...[b, receipt, c]: Parameters<MemoryStorage["commit"]>) {
    const op = this.queue.then(async () => {
      if (this.poisoned) throw Error("writer retired");
      const result = await this.stage.commit(b, () => {}, c);
      if (!result.stored) return result;
      const accepted = b.slice(0, result.stored);
      try {
        await this.db
          .insertInto("pi_journal")
          .values({ batches: serialize(accepted) })
          .execute();
        const applied = await super.commit(accepted, receipt, c);
        if (applied.stored !== result.stored)
          throw Error("journal index mismatch");
        return result;
      } catch (e) {
        this.poisoned = true;
        throw e;
      }
    });
    this.queue = op.then(
      () => {},
      () => {},
    );
    return op;
  }
}
