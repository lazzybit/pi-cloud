import { connect } from "contract/client";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
async function main() {
  const url = new URL(process.env.API_ORIGIN ?? "");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw Error("API_ORIGIN must use HTTPS");
  const file = process.env.OIDC_TOKEN_FILE;
  if (!file) throw Error("set OIDC_TOKEN_FILE to a short-lived access token");
  const api = connect(url.origin, async (request, init) => {
    const r = new Request(request, init);
    if (new URL(r.url).origin !== url.origin) throw Error("unexpected origin");
    r.headers.set(
      "authorization",
      "Bearer " + (await readFile(file, "utf8")).trim(),
    );
    return fetch(r, { redirect: "error" });
  });
  let id = (await api.list()).at(-1) ?? (await api.create()).id;
  const term = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
  });
  const prompt = () => {
    if (process.stdin.isTTY) {
      term.setPrompt(`conversation ${id}> `);
      term.prompt();
    }
  };
  console.log("/new, /list, /open ID, /quit or type a message");
  prompt();
  for await (const line of term) {
    const text = line.trim();
    if (text === "/quit") break;
    if (text === "/list") console.log((await api.list()).join(" "));
    else if (text === "/new") id = (await api.create()).id;
    else if (text.startsWith("/open ")) {
      const n = Number(text.slice(6));
      if ((await api.list()).includes(n)) id = n;
      else console.log("No such conversation");
    } else if (text) {
      await api.send({ id, requestId: crypto.randomUUID(), text });
      const ctl = new AbortController();
      try {
        for await (const snap of await api.watch(
          { id },
          { signal: ctl.signal },
        )) {
          const message = snap.messages
            .filter((m) => m.role === "assistant")
            .at(-1);
          console.log(message?.text || snap.state);
          break;
        }
      } finally {
        ctl.abort();
      }
    }
    prompt();
  }
  term.close();
}
main().catch(() => {
  console.error(
    "Terminal client failed. Check the API origin, access token and connection.",
  );
  process.exitCode = 1;
});
