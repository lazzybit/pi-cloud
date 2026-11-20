import { createHash } from "node:crypto";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { Database } from "../../persistence/pg/database.ts";
import { permissions } from "../../identity/auth.ts";
import { CmdExecutor } from "./executor.ts";
import { lifecycleClient, workerClient } from "./clients.ts";
import { callLedger } from "../../persistence/pg/call-ledger.ts";

export function terminalAdapter(db: Database, controllerURL: string, key: string) {
  if (!key || key.length < 32) throw Error("controller credential required");
  const executor = new CmdExecutor({ ledger: callLedger(db), lifecycle: lifecycleClient(controllerURL, key), worker: workerClient(), grants: permissions });
  const tool = defineTool({
    name: "cmd",
    description: "Run a bounded shell command in the authorized sandbox. Never repeat a command with an unknown outcome.",
    parameters: obj({ command: str() }),
    replay: "safe",
    execute: async ({ command }, api, ctx) => {
      const cid = Number(api.conversationId);
      const id = createHash("sha256").update(JSON.stringify([cid, api.taskId, api.callId])).digest("hex");
      const result = await executor.execute({ cid, id, command, signal: ctx.abortSignal, progress: async (details) => { await api.details(details, ctx); } });
      return {
        details: null,
        isError: !("exitCode" in result) || result.exitCode !== 0,
        output: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });
  return { executor, extension: defineExtension({ name: "sandbox", tools: [tool] }) };
}
