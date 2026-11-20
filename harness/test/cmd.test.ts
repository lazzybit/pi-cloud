import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CmdExecutor, commandDigest, type Intent } from "../src/tools/cmd/executor.ts";

const pod = { uid: "pod-a", url: "http://localhost", key: "test" };
const identity = { owner: "alice", token: "fixture", expires: Date.now() + 60000 };
const result = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
const input = { cid: 1, id: "call", command: "printf ok" };

function fixture() {
  let stored: Intent | undefined;
  let sent = false;
  const ledger = {
    owner: async () => identity.owner,
    find: async () => stored,
    record: vi.fn(async (row: Intent) => { stored = row; }),
    finish: vi.fn(async (_id: string, value: NonNullable<Intent["result"]>) => {
      if (!stored) throw Error("no intent");
      stored.result = value;
    }),
  };
  const grants = vi.fn(async (): Promise<{ volume: boolean } | null> => ({ volume: true }));
  const lifecycle = {
    acquire: vi.fn(async () => pod),
    warm: vi.fn(async () => true),
    validate: vi.fn(async () => "fixture-ticket"),
    lookup: vi.fn(async (): Promise<typeof pod | undefined> => pod),
    release: vi.fn(async () => {}),
    fence: vi.fn(async () => {}),
  };
  const worker = {
    health: vi.fn(async () => "boot-a"),
    start: vi.fn(async () => {
      expect(stored?.boot).toBe("boot-a");
      sent = true;
      throw Error("lost acknowledgment");
    }),
    observe: vi.fn(async (_p, _id, boot) => sent && boot === "boot-a" ? { state: "done" as const, result } : { state: "missing" as const }),
    cancel: vi.fn(async () => {}),
  };
  const boot = () => new CmdExecutor({ ledger, grants, lifecycle, worker, pollMs: 1 });
  return { boot, ledger, grants, lifecycle, worker };
}

describe("durable command dispatch", () => {
  it("hashes the exact UTF-8 command used by the worker", () => {
    const vectors: { command: string; digest: string }[] = JSON.parse(
      readFileSync(new URL("../../sandbox/protocol/command-digest.json", import.meta.url), "utf8"),
    );
    expect(vectors.length).toBeGreaterThan(0);
    for (const { command, digest } of vectors) expect(commandDigest(command)).toBe(digest);
  });

  it("never resends a command after a lost acknowledgment and writer restart", async () => {
    const f = fixture();
    f.ledger.finish.mockRejectedValueOnce(Error("writer retired"));
    const first = f.boot();
    first.authorizeTurn(1, identity);
    await expect(first.execute(input)).rejects.toThrow("writer retired");
    await expect(f.boot().execute(input)).resolves.toEqual(result);
    expect(f.worker.start).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.lookup).toHaveBeenCalledWith("alice", "call", "pod-a");
  });

  it("records unknown if the original worker has restarted", async () => {
    const f = fixture();
    await f.ledger.record({ id: input.id, cid: 1, digest: commandDigest(input.command), pod: pod.uid, boot: "previous-boot", result: null });
    await expect(f.boot().execute(input)).resolves.toMatchObject({ state: "unknown" });
    expect(f.worker.start).not.toHaveBeenCalled();
    expect(f.worker.observe).toHaveBeenCalledWith(pod, "call", "previous-boot");
  });

  it("does not dispatch if the intent cannot be committed", async () => {
    const f = fixture();
    f.ledger.record.mockRejectedValueOnce(Error("database unavailable"));
    const executor = f.boot();
    executor.authorizeTurn(1, identity);
    await expect(executor.execute(input)).rejects.toThrow("database unavailable");
    expect(f.worker.start).not.toHaveBeenCalled();
  });

  it("rechecks authorization after acquiring a ready pod", async () => {
    const f = fixture();
    f.grants.mockResolvedValueOnce({ volume: true }).mockResolvedValueOnce(null);
    const executor = f.boot();
    executor.authorizeTurn(1, identity);
    await expect(executor.execute(input)).rejects.toThrow("sandbox not authorized");
    expect(f.lifecycle.fence).toHaveBeenCalledWith("alice", "call");
    expect(f.ledger.record).not.toHaveBeenCalled();
    expect(f.worker.start).not.toHaveBeenCalled();
  });

  it("rejects commands that cannot be encoded before recording an intent", async () => {
    const f = fixture();
    for (const command of ["bad\u0000input", "\ud800", "界".repeat(3000)]) {
      await expect(f.boot().execute({ ...input, command })).rejects.toThrow("invalid command");
    }
    expect(f.ledger.record).not.toHaveBeenCalled();
  });
});
