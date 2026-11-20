import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { Snapshot, ToolCall } from "./schema.ts";

function text(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((x) => x?.type === "text")
          .map((x) => x.text)
          .join("")
      : "";
}
function terminalResult(raw: string) {
  try {
    const r = JSON.parse(raw);
    if (r && (typeof r.exitCode === "number" || r.state === "unknown"))
      return r;
  } catch {}
}
export function transcript(view: Pick<ConversationView, "entries" | "docs">) {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const messages: Snapshot["messages"] = [];
  const pending = new Map<string, ToolCall>();
  for (const e of view.entries) {
    for (const [i, m] of (e.model ?? []).entries()) {
      const key = `${e.id}:${i}`;
      if (m.role === "user" || m.role === "assistant") {
        const tools: ToolCall[] = [];
        if (m.role === "assistant")
          for (const b of m.content) {
            if (b.type !== "toolCall") continue;
            const call: ToolCall = {
              id: b.id,
              name: b.name,
              arguments: JSON.stringify(b.arguments, null, 2),
              status: "unknown",
            };
            tools.push(call);
            pending.set(b.id, call);
          }
        messages.push({
          key,
          role: m.role,
          text: text(m.content),
          ...(tools.length ? { tools } : {}),
        });
      } else if (m.role === "toolResult") {
        let call = pending.get(m.toolCallId);
        pending.delete(m.toolCallId);
        if (!call) {
          // A transcript window can start between a call and its result.
          call = {
            id: m.toolCallId,
            name: m.toolName,
            arguments: "",
            status: "unknown",
          };
          messages.push({ key, role: "assistant", text: "", tools: [call] });
        }
        const raw = text(m.content),
          r = call.name === "cmd" ? terminalResult(raw) : undefined;
        call.durationMs = m.durationMs;
        call.status =
          r?.state === "unknown"
            ? "unknown"
            : r?.timedOut
              ? "timeout"
              : m.isError || (r && r.exitCode !== 0)
                ? "failed"
                : "done";
        if (r) {
          call.stdout = r.stdout;
          call.stderr = r.stderr;
          call.exitCode = r.exitCode;
        } else call.output = raw;
      }
    }
  }
  for (const slot of live?.tools ?? []) {
    const call = pending.get(slot.callId);
    if (!call) continue;
    const d = slot.details as
      | { phase?: string; stdout?: string; stderr?: string }
      | undefined;
    call.status =
      slot.status === "done"
        ? "unknown"
        : slot.status === "pending" || d?.phase === "queued"
          ? "pending"
          : d?.phase === "preparing"
            ? "preparing"
            : "running";
    call.output = slot.output;
    call.stdout = d?.stdout;
    call.stderr = d?.stderr;
  }
  return { messages, partial: text(live?.generation?.message?.content) };
}
