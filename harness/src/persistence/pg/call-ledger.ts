import type { Database } from "./database.ts";
import type { CallLedger } from "../../tools/cmd/executor.ts";

export function callLedger(db: Database): CallLedger {
  return {
    async owner(cid) {
      return (await db.selectFrom("pi_owner").select("owner").where("cid", "=", cid).executeTakeFirst())?.owner;
    },
    async find(id) {
      const row = await db.selectFrom("pi_call").selectAll().where("id", "=", id).executeTakeFirst();
      return row && { ...row, cid: Number(row.cid) };
    },
    async record(intent) {
      await db.insertInto("pi_call").values({ ...intent, result: null }).execute();
    },
    async finish(id, result) {
      const updated = await db.updateTable("pi_call").set({ result: JSON.stringify(result) }).where("id", "=", id).where("result", "is", null).returning("id").executeTakeFirst();
      if (!updated) throw Error("call intent unavailable");
    },
  };
}
