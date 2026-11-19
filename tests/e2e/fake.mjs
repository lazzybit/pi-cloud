import http from "node:http";
import { setTimeout as wait } from "node:timers/promises";
export function fake() {
  return http.createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const b of req) raw += b;
    const { messages, model, reasoning_effort } = JSON.parse(raw);
    const answer =
      messages.at(-1).content === "inspect settings"
        ? `${model}:${reasoning_effort ?? "default"}`
        : String(messages.at(-1).content);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: "assistant" });
    if (
      messages.at(-1).role === "user" &&
      [
        "fixture workspace probe",
        "fixture interrupted cmd",
        "fixture tool progress",
      ].includes(messages.at(-1).content)
    ) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "fixture_terminal",
            type: "function",
            function: {
              name: "cmd",
              arguments: JSON.stringify({
                command:
                  messages.at(-1).content === "fixture interrupted cmd"
                    ? `exec python3 -c "from pathlib import Path; import time; f=Path('claimed').open('a'); f.write('x'); f.close(); time.sleep(3); print('recovered-result')"`
                    : messages.at(-1).content === "fixture tool progress"
                      ? `exec python3 -u -c "import sys,time; print('begin',end=''); time.sleep(3); sys.stderr.write('problem'); sys.exit(7)"`
                      : "printf terminal-fixture-ok",
              }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    for (const text of ["Test ", "answer: ", answer]) {
      if (res.destroyed) return;
      chunk({ content: text });
      await wait(750);
    }
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  });
}
