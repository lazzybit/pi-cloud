import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
it("claims a call once, returns both streams and preserves workspace on restart", async () => {
  const key = crypto.randomUUID();
  let boot = "";
  const cwd = await mkdtemp(join(tmpdir(), "pi-cmd-"));
  let child: ReturnType<typeof spawn> | undefined;
  const launch = async () => {
    child = spawn(process.execPath, ["worker.ts"], {
      env: {
        ...process.env,
        RUNTIME_KEY: key,
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
    const web = createServer((_request, response) => response.end("direct HTTP"));
    web.listen(0, "127.0.0.1");
    try {
      await once(web, "listening");
      const address = web.address();
      if (!address || typeof address === "string") throw Error("missing HTTP port");
      const net = "c".repeat(64);
      await post("cmd", {
        id: net,
        command: `exec python3 -c 'import urllib.request; assert not urllib.request.getproxies(); print(urllib.request.urlopen("http://localhost:${address.port}", timeout=2).read().decode())'`,
      });
      await expect
        .poll(async () => (await post("get", { id: net })).state)
        .toBe("done");
      expect((await post("get", { id: net })).result).toMatchObject({
        stdout: "direct HTTP\n",
        stderr: "",
        exitCode: 0,
      });
      const local = "d".repeat(64);
      await post("cmd", {
        id: local,
        command: "exec python3 -c 'import http.client; conn = http.client.HTTPConnection(\"localhost\", 35329, timeout=2); conn.request(\"POST\", \"/cmd\"); print(conn.getresponse().status)'",
      });
      await expect
        .poll(async () => (await post("get", { id: local })).result?.stdout)
        .toBe("403\n");
    } finally {
      web.close();
    }
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
