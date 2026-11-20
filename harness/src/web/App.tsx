import { createSignal, For } from "solid-js";
import { getRequestEvent } from "@solidjs/web";
const transport = () => import("./transport.ts");
import type { Snapshot, Settings, ToolCall } from "./schema.ts";
import "./web.css";

function effortLabel(effort: Settings["effort"]) {
  return effort === "default" ? "默認" : effort;
}

const toolStatus = {
  pending: "等待中",
  preparing: "啟動沙箱中",
  running: "執行中",
  done: "已完成",
  failed: "失敗",
  cancelled: "已取消",
  timeout: "逾時",
  unknown: "結果未知",
} as const;
function ToolCard(props: { call: ToolCall }) {
  const c = () => props.call;
  return (
    <details class="tool-call">
      <summary>
        <code>{c().name}</code> · {toolStatus[c().status]}
        {c().durationMs !== undefined
          ? ` · ${(c().durationMs! / 1000).toFixed(1)} 秒`
          : ""}
      </summary>
      <small>輸入參數</small>
      <pre>{c().arguments || "未保留"}</pre>
      {c().stdout !== undefined && (
        <>
          <small>stdout</small>
          <pre data-stream="stdout">{c().stdout || "（空）"}</pre>
        </>
      )}
      {c().stderr !== undefined && (
        <>
          <small>stderr</small>
          <pre data-stream="stderr">{c().stderr || "（空）"}</pre>
        </>
      )}
      {c().output && (
        <>
          <small>工具輸出</small>
          <pre>{c().output}</pre>
        </>
      )}
      {c().exitCode !== undefined && <small>退出碼：{c().exitCode}</small>}
      <For each={c().children} keyed={(child) => child.id}>
        {(child) => <ToolCard call={child()} />}
      </For>
    </details>
  );
}
export default function App() {
  const initialIds: number[] =
    typeof document === "undefined"
      ? ((getRequestEvent()?.locals.conversationIds as number[]) ?? [])
      : JSON.parse(document.documentElement.dataset.conversations ?? "[]");
  const initialSnapshot: Snapshot | null =
    typeof document === "undefined"
      ? ((getRequestEvent()?.locals.initialSnapshot as Snapshot) ?? null)
      : JSON.parse(document.documentElement.dataset.snapshot ?? "null");
  const [snap, set] = createSignal<Snapshot | null>(initialSnapshot),
    [text, draft] = createSignal(""),
    [notice, note] = createSignal(initialSnapshot ? "" : "連線中"),
    [ids, index] = createSignal<number[]>(initialIds),
    [busy, lock] = createSignal(false);
  let id = initialSnapshot?.id ?? 0,
    sub: AbortController | undefined;
  async function open(n: number) {
    sub?.abort();
    if (n !== id) set(null);
    id = n;
    draft("");
    lock(false);
    history.replaceState(null, "", `/c/${n}`);
    const ctl = new AbortController();
    sub = ctl;
    while (!ctl.signal.aborted) {
      try {
        const api = await transport();
        for await (const s of await api.subscribe(n, ctl.signal)) {
          if (ctl.signal.aborted) return;
          set(s);
          note("");
        }
      } catch {}
      if (!ctl.signal.aborted) {
        note("重新連線中");
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  async function init(fresh = false) {
    sub?.abort();
    if (fresh || !snap()) {
      set(null);
      note("開啟對話中");
    }
    try {
      let all = ids();
      let n = fresh ? 0 : Number(location.pathname.split("/")[2]) || all.at(-1);
      if (!n) {
        n = (await (await transport()).create()).id;
        all = [...all, n];
      }
      index(all);
      void open(n);
    } catch (e) {
      console.error(e instanceof Error ? e.message : "open failed");
      note("無法開啟對話");
    }
  }
  async function send() {
    const t = text().trim(),
      n = id;
    if (!t || !settingsAvailable() || busy() || snap()?.state === "running") return;
    const req = crypto.randomUUID();
    lock(true);
    draft("");
    try {
      for (let i = 0; ; i++) {
        try {
          await (await transport()).send({ id: n, text: t, requestId: req });
          break;
        } catch (e) {
          if (i >= 4 || (e as { status?: number }).status === 409) throw e;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    } catch {
      if (n === id) note("送出未確認，請查看對話紀錄");
    } finally {
      if (n === id) lock(false);
    }
  }
  async function configure(change: Partial<Settings>) {
    const s = snap();
    if (!s || busy() || s.state === "running") return;
    const settings = { ...s.settings, ...change };
    const model = s.models.find((m) => m.id === settings.model);
    if (change.model && !model?.efforts.includes(settings.effort))
      settings.effort = "default";
    lock(true);
    const current = sub;
    try {
      const saved = await (
        await transport()
      ).configure({
        id: s.id,
        settings,
      });
      if (sub === current) set((prev) => prev && { ...prev, settings: saved });
    } catch {
      if (sub === current) {
        void open(s.id);
        note("設定未確認，重新讀取中");
      }
    } finally {
      if (sub === current) lock(false);
    }
  }
  const efforts = () => {
    const s = snap();
    return s?.models.find((model) => model.id === s.settings.model)?.efforts;
  };
  const settingsAvailable = () => {
    const s = snap();
    return s ? efforts()?.includes(s.settings.effort) : false;
  };
  if (typeof window !== "undefined") queueMicrotask(() => void init());
  return (
    <main>
      <header>
        <h1>Pi</h1>
        <select
          aria-label="最近對話"
          value={String(id)}
          onChange={(e) => void open(Number(e.currentTarget.value))}
        >
          <For each={ids()}>{(n) => <option value={n}>對話 {n}</option>}</For>
        </select>
        <button disabled={!snap()} onClick={() => void init(true)}>
          新對話
        </button>
      </header>
      <fieldset disabled={!snap() || busy() || snap()?.state === "running"}>
        <legend>本對話設定</legend>
        <label>
          模型{" "}
          <select
            aria-label="模型"
            onChange={(e) => void configure({ model: e.currentTarget.value })}
          >
            {snap() && !efforts() && (
              <option value={snap()!.settings.model} selected disabled>
                {snap()!.settings.model || "模型"}（不可用）
              </option>
            )}
            <For each={snap()?.models}>
              {(m) => (
                <option value={m.id} selected={m.id === snap()?.settings.model}>
                  {m.id}
                </option>
              )}
            </For>
          </select>
        </label>{" "}
        <label>
          思考強度{" "}
          <select
            aria-label="思考強度"
            disabled={!efforts()}
            onChange={(e) =>
              void configure({
                effort: e.currentTarget.value as Settings["effort"],
              })
            }
          >
            {efforts() && !settingsAvailable() && (
              <option value={snap()!.settings.effort} selected disabled>
                {effortLabel(snap()!.settings.effort)}（不可用）
              </option>
            )}
            <For each={efforts()}>
              {(v) => (
                <option value={v} selected={v === snap()?.settings.effort}>
                  {effortLabel(v)}
                </option>
              )}
            </For>
          </select>
        </label>
      </fieldset>
      <section>
        <For each={snap()?.messages} keyed={(m) => m.key}>
          {(m) => (
            <article data-role={m().role}>
              {(m().text || !m().tools?.length) && (
                <>
                  <small>{m().role === "user" ? "你" : "Pi"}</small>
                  <p>{m().text}</p>
                </>
              )}
              <For each={m().tools} keyed={(t) => t.id}>
                {(t) => <ToolCard call={t()} />}
              </For>
            </article>
          )}
        </For>
        <p data-testid="partial">{snap()?.partial}</p>
      </section>
      <footer>
        <output role="status">{notice() || snap()?.state}</output>
        <textarea
          aria-label="訊息"
          disabled={!snap()}
          placeholder="輸入訊息…"
          value={text()}
          onInput={(e) => draft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {snap()?.state === "running" ? (
          <button
            onClick={() =>
              void transport()
                .then((api) => api.stop({ id, requestId: snap()!.turn! }))
                .catch(() => note("停止未確認"))
            }
          >
            停止
          </button>
        ) : (
          <button
            disabled={busy() || !text().trim() || !settingsAvailable()}
            onClick={() => void send()}
          >
            送出
          </button>
        )}
      </footer>
    </main>
  );
}
