import { type } from "arktype";
export const conversation = type({
  id: "1 <= number.integer <= 9007199254740991",
  "+": "reject",
});
export const sendInput = type({
  id: conversation.get("id"),
  requestId: "string.uuid",
  text: "string.trim |> 1 <= string <= 32000",
  "+": "reject",
});
export const stopInput = type({
  id: conversation.get("id"),
  requestId: "string.uuid",
  "+": "reject",
});
export const settings = type({
  model: "1 <= string <= 128",
  effort: "'default' | 'low' | 'medium' | 'high'",
  "+": "reject",
});
export const configureInput = type({
  id: conversation.get("id"),
  settings,
  "+": "reject",
});
export type Settings = typeof settings.infer;
export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
  status:
    | "pending"
    | "preparing"
    | "running"
    | "done"
    | "failed"
    | "unknown"
    | "timeout";
  stdout?: string;
  stderr?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
};
export type Snapshot = {
  id: number;
  settings: Settings;
  models: string[];
  messages: {
    key: string;
    role: "user" | "assistant";
    text: string;
    tools?: ToolCall[];
  }[];
  partial: string;
  turn: string | null;
  state: "idle" | "running" | "done" | "stopped" | "failed";
};
