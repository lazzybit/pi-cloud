import { expect, it } from "vitest";
import { transcript } from "../harness/transcript.ts";
import type { ConversationView } from "@earendil-works/pi-durable";
it("keeps repeated provider IDs separate across rounds and does not invent a result", () => {
  const call = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "repeat",
        name: "cmd",
        arguments: { command: "true" },
      },
    ],
  };
  const result = {
    role: "toolResult",
    toolCallId: "repeat",
    toolName: "cmd",
    isError: false,
    content: [{ type: "text", text: '{"stdout":"","stderr":"","exitCode":0}' }],
  };
  const view = {
    entries: [call, result, call].map((m, i) => ({ id: i + 1, model: [m] })),
    docs: {},
  } as unknown as ConversationView;
  expect(
    transcript(view).messages.map((m) => [m.key, m.tools?.[0].status]),
  ).toEqual([
    ["1:0", "done"],
    ["3:0", "unknown"],
  ]);
});
