import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const models = [
  { id: "fixture", reasoningEfforts: [{ value: "high" }] },
  { id: "fixture-alt" },
  { id: "gpt-5.2" },
  { id: "gpt-4.1-mini" },
];
const commands: Record<string, string> = {
  "fixture interrupted cmd": `exec python3 -c "from pathlib import Path; import time; f=Path('claimed').open('a'); f.write('x'); f.close(); time.sleep(3); print('recovered-result')"`,
  "fixture tool progress": `exec python3 -u -c "import sys,time; print('begin',end=''); time.sleep(3); sys.stderr.write('problem'); sys.exit(7)"`,
  "fixture native network": `exec python3 -c 'import urllib.request; assert not urllib.request.getproxies(); print(urllib.request.urlopen("http://localhost:35322/fixture-network", timeout=3).read().decode())'`,
};
export function fake() {
  return http.createServer(async (req, res) => {
    if (req.url === "/fixture-network") {
      res.end("native HTTP fixture reached");
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const b of req) raw += b;
    const { input, model, reasoning, tools, stream, store } = JSON.parse(raw);
    if (!Array.isArray(input) || stream !== true || store !== false || !models.some((m) => m.id === model)) {
      res.writeHead(400).end("Invalid Responses request");
      return;
    }
    const last = input.at(-1);
    const prompt = last?.role === "user" ? last.content.find((p) => p.type === "input_text")?.text : undefined;
    const command = prompt && Object.hasOwn(commands, prompt) ? commands[prompt] : undefined;
    if (command && !tools?.some((t) => t.type === "function" && t.name === "cmd")) {
      res.writeHead(400).end("Expected cmd tool in Responses format");
      return;
    }
    const id = randomUUID();
    res.writeHead(200, { "content-type": "text/event-stream" });
    function event(type, data) {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    }
    const response = (status, output) => ({ id: `resp_${id}`, object: "response", model, status, output });
    event("response.created", { response: response("in_progress", []) });
    if (command) {
      const call = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "cmd" };
      const args = JSON.stringify({ command });
      event("response.output_item.added", { output_index: 0, item: { ...call, arguments: "", status: "in_progress" } });
      event("response.function_call_arguments.delta", { output_index: 0, item_id: call.id, delta: args });
      const item = { ...call, arguments: args, status: "completed" };
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: response("completed", [item]) });
      res.end();
      return;
    }
    const answer = prompt === "inspect settings"
      ? `${model}:${reasoning === undefined ? "default" : reasoning.effort ?? "missing effort"}`
      : String(last?.type === "function_call_output" ? last.output : prompt);
    const message = { type: "message", id: `msg_${id}`, role: "assistant" };
    event("response.output_item.added", { output_index: 0, item: { ...message, content: [], status: "in_progress" } });
    const chunks = ["Test ", "answer: ", answer];
    for (const delta of chunks) {
      if (res.destroyed) return;
      event("response.output_text.delta", { output_index: 0, item_id: message.id, content_index: 0, delta });
      await wait(750);
    }
    if (res.destroyed) return;
    const item = { ...message, content: [{ type: "output_text", text: chunks.join(""), annotations: [] }], status: "completed" };
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: response("completed", [item]) });
    res.end();
  });
}
