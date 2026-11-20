import { CodemodeSandbox, parseCodemodeSource, type CodemodeRunOptions } from "@earendil-works/pi-codemode";
import { NestedCallDoc } from "@earendil-works/pi-durable";
import { createCodemodeExtension, type CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";

const timeLimitMs = 180_000;
const maxCalls = 16;

class BoundedSandbox extends CodemodeSandbox {
  override start(code: string, options: CodemodeRunOptions) {
    const limit = new AbortController();
    const signal = options.signal ? AbortSignal.any([limit.signal, options.signal]) : limit.signal;
    const run = super.start(code, {
      ...options,
      signal,
      timeoutMs: Math.min(options.timeoutMs ?? timeLimitMs, timeLimitMs),
      onCall(call) {
        if (call.id > maxCalls) limit.abort();
        else options.onCall(call);
      },
    });
    return {
      deliver: run.deliver.bind(run),
      get finished() { return run.finished; },
      result: run.result.then((result) => limit.signal.aborted
        ? { ...result, ok: false as const, error: { kind: "sandbox" as const, message: "Code Mode call limit exceeded" } }
        : result),
    };
  }
}

export function codeMode() {
  let workers = 0;
  const sandbox = new BoundedSandbox({
    memoryLimitBytes: 32 * 1024 * 1024,
    acquireWorker() {
      if (workers >= 4) throw Error("Code Mode is at capacity");
      workers++;
      return () => { workers--; };
    },
  });
  const extension = createCodemodeExtension({ sandbox, models: false });
  const [tool] = extension.tools!;
  return {
    close: () => sandbox.close(),
    extension: {
      ...extension,
      tools: [{
        ...tool,
        async execute(args: { code: string }, api: Parameters<typeof tool.execute>[1], ctx: Parameters<typeof tool.execute>[2]) {
          if (Buffer.byteLength(args.code) > 16_384) throw Error("Code Mode source is too large");
          const { code, options } = parseCodemodeSource(args.code);
          const limits = {
            timeout_ms: Math.min(options.timeoutMs ?? timeLimitMs, timeLimitMs),
            max_output_tokens: Math.min(options.maxOutputTokens ?? 2048, 2048),
          };
          const result = await tool.execute({ code: `// @options: ${JSON.stringify(limits)}\n${code}` }, api, ctx);
          const details = result.details as CodemodeToolDetails | undefined;
          if (!details?.calls.length) return result;
          // The SDK retires these task-scoped results when the parent tool settles.
          const calls = await Promise.all(details.calls.map(async (call) => {
            const child = await api.snapshot(NestedCallDoc, api.taskId, `c${call.id}`, ctx);
            return { ...call, result: child?.result?.structuredOutput ?? null };
          }));
          return { ...result, details: { ...details, calls } };
        },
      }],
    },
  };
}
