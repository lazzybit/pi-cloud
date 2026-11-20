import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("leaves the inherited UID limits unchanged for sandbox commands", () => {
  const command = "import resource; print(resource.getrlimit(resource.RLIMIT_NPROC))";
  const inherited = execFileSync("python3", ["-c", command], { encoding: "utf8" });
  const guarded = execFileSync("./guard", ["/tmp", `exec python3 -c '${command}'`], {
    encoding: "utf8",
  });
  expect(guarded).toBe(inherited);
});
