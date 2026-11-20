"use server";
import { getRequestEvent } from "@solidjs/web";
import { type } from "arktype";
import type { Identity } from "../auth.ts";
import { service } from "../service.ts";
import {
  conversation,
  sendInput,
  stopInput,
  configureInput,
} from "../schema.ts";
async function context() {
  const e = getRequestEvent();
  const who = e?.locals.identity as Identity | undefined;
  if (!e || !who || who.expires <= Date.now())
    throw new Response(null, { status: 401 });
  return {
    app: (await service()).app,
    who,
    signal: AbortSignal.any([
      e.request.signal,
      AbortSignal.timeout(Math.max(1, who.expires - Date.now())),
    ]),
  };
}
function valid<T>(result: T | type.errors): T {
  if (result instanceof type.errors) throw new Response(null, { status: 400 });
  return result;
}
export async function list() {
  const { app, who } = await context();
  return app.list(who.owner);
}
export async function create() {
  const { app, who } = await context();
  return app.create(who.owner);
}
export async function send(input: typeof sendInput.inferIn) {
  const { id, requestId, text } = valid(sendInput(input));
  const { app, who } = await context();
  await app.owned(who.owner, id);
  return app.send(id, requestId, text, who);
}
export async function stop(input: typeof stopInput.inferIn) {
  const { id, requestId } = valid(stopInput(input));
  const { app, who } = await context();
  await app.owned(who.owner, id);
  return app.stop(id, requestId);
}
export async function configure(input: typeof configureInput.inferIn) {
  const { id, settings } = valid(configureInput(input));
  const { app, who } = await context();
  await app.owned(who.owner, id);
  return app.configure(id, settings);
}
export async function watch(input: typeof conversation.inferIn) {
  const { id } = valid(conversation(input));
  const { app, who, signal } = await context();
  await app.owned(who.owner, id);
  return app.watch(id, signal);
}
