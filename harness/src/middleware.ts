import type { StartMiddleware } from "@solidjs/vite-plugin";
import { begin, callback, session } from "../session.ts";
import { service } from "../service.ts";
import { trustedUrl } from "../auth.ts";
const middleware: StartMiddleware = async (event, next) => {
  const r = event.request,
    url = new URL(r.url),
    path = url.pathname;
  const publicUrl = trustedUrl(process.env.PUBLIC_ORIGIN!);
  if (r.headers.get("host") !== publicUrl.host)
    return new Response(null, { status: 403 });
  event.response.headers.set("cache-control", "private, no-store");
  event.response.headers.set("referrer-policy", "no-referrer");
  event.response.headers.set("x-content-type-options", "nosniff");
  if (path === "/callback" && r.method === "GET") {
    try {
      return await callback(r);
    } catch {
      return new Response("Login failed", { status: 401 });
    }
  }
  const rpc = path.startsWith("/_server/");
  if (
    !rpc &&
    !(r.method === "GET" && (path === "/" || /^\/c\/\d+$/.test(path)))
  )
    return new Response(null, { status: 404 });
  if (
    rpc &&
    (r.method !== "POST" || r.headers.get("origin") !== publicUrl.origin)
  )
    return new Response(null, { status: 403 });
  const who = await session(r);
  if (!who) return rpc ? new Response(null, { status: 401 }) : begin(path);
  event.locals.identity = who;
  if (!rpc) {
    const { app } = await service();
    const ids = await app.list(who.owner);
    event.locals.conversationIds = ids;
    const id = path === "/" ? ids.at(-1) : Number(path.slice(3));
    if (id && !ids.includes(id)) return new Response(null, { status: 404 });
    if (id) {
      const stream = app.watch(id, r.signal);
      try {
        const { value } = await stream.next();
        // Render short conversations immediately; don't duplicate a large transcript in HTML.
        if (value && JSON.stringify(value).length <= 16384)
          event.locals.initialSnapshot = value;
      } finally {
        await stream.return();
      }
    }
  }
  return next();
};
export default middleware;
