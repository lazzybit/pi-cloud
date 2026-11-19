import { oc, eventIterator } from "@orpc/contract";
import { z } from "zod";
const id = z.coerce.number<number>().int().positive();
export const sendInput = z.object({
  id,
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(32000),
});
const toolCall = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  status: z.enum([
    "pending",
    "preparing",
    "running",
    "done",
    "failed",
    "unknown",
    "timeout",
  ]),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
});
export type ToolCall = z.infer<typeof toolCall>;
const message = z.object({
  key: z.string(),
  tools: z.array(toolCall).optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export const settings = z.object({
  model: z.string().min(1).max(128),
  effort: z.enum(["default", "low", "medium", "high"]),
});
export type Settings = z.infer<typeof settings>;
export const snapshot = z.object({
  id,
  settings,
  models: z.array(z.string()),
  messages: z.array(message),
  partial: z.string(),
  turn: z.string().nullable(),
  state: z.enum(["idle", "running", "done", "stopped", "failed"]),
});
export type Snapshot = z.infer<typeof snapshot>;
const api = oc.errors({
  CONFLICT: { status: 409 },
  NOT_FOUND: { status: 404 },
});
export const contract = {
  configure: api
    .route({ method: "PUT", path: "/conversations/{id}/settings" })
    .input(z.object({ id, settings }))
    .output(settings),
  create: api
    .route({ method: "POST", path: "/conversations" })
    .output(z.object({ id })),
  list: api
    .route({ method: "GET", path: "/conversations" })
    .output(z.array(id)),
  send: api
    .route({ method: "POST", path: "/conversations/{id}/turns" })
    .input(sendInput)
    .output(z.object({ status: z.string() })),
  stop: api
    .route({ method: "POST", path: "/conversations/{id}/stop" })
    .input(z.object({ id, requestId: z.uuid() }))
    .output(z.boolean()),
  watch: api
    .route({ method: "GET", path: "/conversations/{id}/watch" })
    .input(z.object({ id }))
    .output(eventIterator(snapshot)),
};
