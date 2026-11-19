import { it, expect } from "vitest";
import { profile, pod, expired } from "../policy.ts";
const config = { image: "example.invalid/sandbox@sha256:" + "a".repeat(64) },
  grants = { volume: true, web: false },
  owner = "d".repeat(64);
it("binds identity, actual claim UID, egress and image revision", () => {
  const a = profile(owner, grants, config, "uid-a"),
    b = profile("e".repeat(64), grants, config, "uid-b");
  expect(a.name).not.toBe(b.name);
  expect(a.claim).not.toBe(b.claim);
  for (const other of [
    profile(owner, grants, config, "uid-b"),
    profile(owner, { ...grants, web: true }, config, "uid-a"),
    profile(owner, grants, { ...config, revision: "v2" }, "uid-a"),
  ])
    expect(a.binding).not.toBe(other.binding);
  const s = pod(a, grants, config).spec;
  expect(s.automountServiceAccountToken).toBe(false);
  expect(s.volumes[0]).toMatchObject({
    persistentVolumeClaim: { claimName: a.claim },
  });
  expect(
    pod(
      profile(owner, { volume: false, web: false }, config),
      { volume: false, web: false },
      config,
    ).spec.volumes[0],
  ).toHaveProperty("emptyDir");
});
it("reclaims only after activity and outstanding lease grace", () => {
  expect(expired({ activity: "100" }, 600099, 600000)).toBe(false);
  expect(expired({ activity: "100" }, 600100, 600000)).toBe(true);
  expect(expired({ activity: "100", until: "601000" }, 600100, 600000)).toBe(
    false,
  );
});
