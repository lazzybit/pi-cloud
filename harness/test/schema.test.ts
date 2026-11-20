import { expect, it } from "vitest";
import { sendInput } from "../src/web/schema.ts";
it("validates and normalizes RPC arguments before dispatch", () => {
  const input = { id: 2, requestId: crypto.randomUUID(), text: " hello " };
  expect(sendInput.assert(input).text).toBe("hello");
  for (const bad of [
    { text: " " },
    { text: "x".repeat(32001) },
    { owner: "other" },
    { id: -1 },
    { requestId: "no" },
  ])
    expect(() => sendInput.assert({ ...input, ...bad })).toThrow();
});
