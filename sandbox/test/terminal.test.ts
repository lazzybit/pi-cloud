import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
it("claims a call once, returns both streams and preserves workspace on restart", async () => {
  const key = crypto.randomUUID();
  let boot = "";
  const cwd = await mkdtemp(join(tmpdir(), "pi-cmd-"));
  let child: ReturnType<typeof spawn> | undefined;
  const launch = async () => {
    child = spawn("python3", ["worker.py"], {
      env: {
        ...process.env,
        RUNTIME_KEY: key,
        EGRESS_WEB: "1",
        WORKSPACE: cwd,
        PORT: "35329",
        BIND: "127.0.0.1",
        GUARD: process.cwd() + "/guard",
      },
    });
    await Promise.race([
      once(child.stdout!, "data"),
      once(child, "exit").then(() => {
        throw Error("worker did not start");
      }),
    ]);
  };
  const post = async (path: string, data: object) => {
    const r = await fetch("http://127.0.0.1:35329/" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: JSON.stringify({ ...data, boot }),
    });
    return await r.json();
  };
  const id = "a".repeat(64);
  try {
    await launch();
    boot = (await post("health", {})).boot;
    const cmd = {
      id,
      command: "printf x >> marker; printf hello; printf oops >&2",
    };
    await post("cmd", cmd);
    await post("cmd", cmd);
    await expect
      .poll(async () => (await post("get", { id })).result?.stdout)
      .toBe("hello");
    expect((await post("get", { id })).result.stderr).toBe("oops");
    expect(await readFile(join(cwd, "marker"), "utf8")).toBe("x");
    const cid = "b".repeat(64);
    await post("cmd", { id: cid, command: "exec sleep 10" });
    await post("cancel", { id: cid });
    await expect
      .poll(async () => (await post("get", { id: cid })).state)
      .toBe("done");
    expect((await post("get", { id: cid })).result.exitCode).not.toBe(0);
    const proxy = "d".repeat(64);
    await post("cmd", {
      id: proxy,
      command: `exec python3 -c 'import socket,os; s=socket.socket(socket.AF_UNIX); s.connect(os.environ["PI_EGRESS_SOCKET"]); s.sendall(bytes([5,1,0])); print(s.recv(2).hex()); s.sendall(bytes([5,1,0,1,127,0,0,1,1,187])); print(s.recv(10)[1])'`,
    });
    await expect
      .poll(async () => (await post("get", { id: proxy })).state)
      .toBe("done");
    expect((await post("get", { id: proxy })).result.stdout).toBe("0500\n2\n");
    const net = "c".repeat(64);
    await post("cmd", {
      id: net,
      command: `exec python3 -c 'import socket;socket.socket()'`,
    });
    await expect
      .poll(async () => (await post("get", { id: net })).state)
      .toBe("done");
    expect((await post("get", { id: net })).result.exitCode).not.toBe(0);
    child!.kill();
    await once(child!, "exit");
    await launch();
    expect((await post("get", { id })).state).toBe("missing");
    expect(await readFile(join(cwd, "marker"), "utf8")).toBe("x");
  } finally {
    child?.kill();
    await rm(cwd, { recursive: true, force: true });
  }
});
