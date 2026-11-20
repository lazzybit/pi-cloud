import type { ParentProps } from "solid-js";
import { getRequestEvent, HydrationScript } from "@solidjs/web";
export default function Document(props: ParentProps) {
  return (
    <html
      lang="zh-Hant"
      data-snapshot={JSON.stringify(
        getRequestEvent()?.locals.initialSnapshot ?? null,
      )}
      data-conversations={JSON.stringify(
        getRequestEvent()?.locals.conversationIds ?? [],
      )}
    >
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="Pi 私人對話與工具執行紀錄" />
        <title>Pi · 對話</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
