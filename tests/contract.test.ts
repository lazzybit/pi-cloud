import { expect, it } from "vitest";
import { sendInput } from "../contract/contract.ts";
it("rejects whitespace and bounds prompt size", () => {
  for (const text of [" ", "x".repeat(32001)])
    expect(
      sendInput.safeParse({ id: 2, requestId: crypto.randomUUID(), text })
        .success,
    ).toBe(false);
  expect(
    sendInput.parse({ id: 2, requestId: crypto.randomUUID(), text: "hello" })
      .text,
  ).toBe("hello");
});
