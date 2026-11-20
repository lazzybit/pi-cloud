import type { StartMiddleware } from "@solidjs/vite-plugin";
import {
  authenticatedUserFromSession,
  completeLogin,
  redirectToLogin,
} from "./session.ts";
import { service } from "./service.ts";
import { trustedUrl } from "./auth.ts";
import { isChatPage } from "./chat-path.ts";

type RequestEvent = Parameters<StartMiddleware>[0];
const maxInlineSnapshotCharacters = 16_384;

function isSameOriginPost(request: Request, origin: string) {
  return request.method === "POST" && request.headers.get("origin") === origin;
}

async function renderChatPage(
  event: RequestEvent,
  next: Parameters<StartMiddleware>[1],
  owner: string,
  path: string,
) {
  const { app } = await service();
  const ownedIds = await app.list(owner);
  event.locals.conversationIds = ownedIds;
  const conversationId =
    path === "/" ? ownedIds.at(-1) : Number(path.slice("/c/".length));
  if (conversationId && !ownedIds.includes(conversationId))
    return new Response(null, { status: 404 });
  if (conversationId) {
    const stream = app.watch(conversationId, event.request.signal);
    try {
      const { value: snapshot } = await stream.next();
      // Large transcripts arrive over the live subscription instead of twice in the HTML.
      if (
        snapshot &&
        JSON.stringify(snapshot).length <= maxInlineSnapshotCharacters
      )
        event.locals.initialSnapshot = snapshot;
    } finally {
      await stream.return();
    }
  }
  return next();
}

const middleware: StartMiddleware = async (event, next) => {
  const { request } = event;
  const path = new URL(request.url).pathname;
  const publicUrl = trustedUrl(process.env.PUBLIC_ORIGIN!);
  if (request.headers.get("host") !== publicUrl.host)
    return new Response(null, { status: 403 });
  event.response.headers.set("cache-control", "private, no-store");
  event.response.headers.set("referrer-policy", "no-referrer");
  event.response.headers.set("x-content-type-options", "nosniff");

  if (request.method === "GET" && path === "/callback") {
    try {
      return await completeLogin(request);
    } catch {
      return new Response("Login failed", { status: 401 });
    }
  }

  if (path.startsWith("/_server/")) {
    if (!isSameOriginPost(request, publicUrl.origin))
      return new Response(null, { status: 403 });
    const user = await authenticatedUserFromSession(request);
    if (!user) return new Response(null, { status: 401 });
    event.locals.identity = user;
    return next();
  }

  if (request.method !== "GET" || !isChatPage(path))
    return new Response(null, { status: 404 });
  const user = await authenticatedUserFromSession(request);
  if (!user) return redirectToLogin(path);
  event.locals.identity = user;
  return renderChatPage(event, next, user.owner, path);
};
export default middleware;
