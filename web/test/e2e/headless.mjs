import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
// No Web or ingress process is running here. Only the temporary test client permits password grant.
export async function headless({ dir, issuer, password, origin }) {
  const api = "http://127.0.0.1:38444";
  for (const path of ["/", "/callback", "/auth/config"])
    assert.equal((await fetch(api + path)).status, 404);
  assert.equal((await fetch(api + "/api/v1/conversations")).status, 401);
  const response = await fetch(issuer + "/protocol/openid-connect/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      username: "first",
      password,
      client_id: "terminal-fixture",
    }),
  });
  assert.equal(response.status, 200);
  const tokenFile = dir + "/access";
  await writeFile(tokenFile, (await response.json()).access_token, {
    mode: 0o600,
  });
  try {
    const image = process.env.TUI_IMAGE;
    const child = spawn(
      image ? "docker" : process.execPath,
      image
        ? [
            "run",
            "--rm",
            "-i",
            "--network",
            "host",
            "--user",
            `${process.getuid()}:${process.getgid()}`,
            "--mount",
            `type=bind,src=${tokenFile},dst=/run/access,readonly`,
            "-e",
            "API_ORIGIN",
            "-e",
            "OIDC_TOKEN_FILE",
            image,
          ]
        : ["tui/dist/tui.mjs"],
      {
        env: {
          ...process.env,
          API_ORIGIN: api,
          OIDC_TOKEN_FILE: image ? "/run/access" : tokenFile,
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const ended = once(child, "exit");
    child.stdin.end("/new\nterminal-only-check\n/quit\n");
    assert.equal((await ended)[0], 0);
    assert.match(out, /Test answer: terminal-only-check/);
    console.log("PASS: TUI completes a turn before Web starts");
  } finally {
    await rm(tokenFile, { force: true });
  }
}
