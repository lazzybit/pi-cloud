import { expect, it } from "vitest";
import { parseRequest } from "../types.ts";
const base = { owner: "a".repeat(64), id: "test" };
it("requires boolean grants for warm-up and a Pod UID for dispatch checks", () => {
  const grants = { volume: false, web: true };
  expect(parseRequest({ ...base, action: "warm", grants })).toEqual({
    ...base,
    action: "warm",
    grants,
  });
  expect(() =>
    parseRequest({
      ...base,
      action: "warm",
      grants: { volume: "false", web: true },
    }),
  ).toThrow();
  expect(() => parseRequest({ ...base, action: "check", grants })).toThrow();
  expect(
    parseRequest({ ...base, action: "check", grants, uid: "pod" }),
  ).toMatchObject({ uid: "pod", grants });
});
it("accepts observation and release without grants but rejects unknown actions", () => {
  for (const action of ["lookup", "release"])
    expect(parseRequest({ ...base, action, uid: "pod" })).toEqual({
      ...base,
      action,
      uid: "pod",
    });
  expect(() => parseRequest({ ...base, action: "replace" })).toThrow();
});
