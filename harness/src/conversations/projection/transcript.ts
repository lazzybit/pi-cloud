import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { CodemodeNestedCall } from "@earendil-works/pi-durable/codemode";
import type { Result } from "../../tools/cmd/executor.ts";
import type { Snapshot, ToolCall } from "../../web/schema.ts";

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
function commandOutput(call: ToolCall, result: Result) {
  call.stderr = result.stderr;
  if ("exitCode" in result) {
    call.stdout = result.stdout;
    call.exitCode = result.exitCode;
    call.status = result.timedOut ? "timeout" : result.exitCode === 0 ? "done" : "failed";
  } else call.status = "unknown";
}
function completedChildren(call: ToolCall, details: unknown) {
  const rows = (details as { calls?: (CodemodeNestedCall & { result?: Result | null })[] } | undefined)?.calls;
  if (!rows?.length) return;
  call.children = rows.map((row) => {
    const child: ToolCall = {
      id: `${call.id}/c${row.id}`, name: row.name, arguments: row.args,
      status: row.status === "ok" ? "done" : row.status === "error" ? "failed" : "cancelled",
      durationMs: row.durationMs, output: row.error,
    };
    if (row.name === "cmd" && row.result) commandOutput(child, row.result);
    return child;
  });
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
        call.status = m.isError ? "failed" : "done";
        if (r) commandOutput(call, r);
        else call.output = raw;
        if (call.name === "codemode") completedChildren(call, m.details);
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
  for (const slot of live?.nestedTools ?? []) {
    const parent = pending.get(slot.parentCallId);
    if (parent?.name !== "codemode") continue;
    const d = slot.details as { phase?: string; stdout?: string; stderr?: string } | undefined;
    (parent.children ??= []).push({
      id: slot.callId, name: slot.name, arguments: JSON.stringify(slot.arguments, null, 2),
      status: slot.status === "done" ? (slot.summary ? slot.summary.isError ? "failed" : "done" : "unknown")
        : slot.status === "pending" || d?.phase === "queued" ? "pending"
        : d?.phase === "preparing" ? "preparing" : "running",
      stdout: d?.stdout, stderr: d?.stderr, output: slot.output ?? slot.summary?.error,
      durationMs: slot.summary?.durationMs,
    });
  }
  return { messages, partial: text(live?.generation?.message?.content) };
}
