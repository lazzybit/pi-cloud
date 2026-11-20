"use server";
import { getRequestEvent } from "@solidjs/web";
import { type } from "arktype";
import type { Identity } from "../identity/auth.ts";
import { service } from "../bootstrap/service.ts";
import {
  conversation,
  sendInput,
  stopInput,
  configureInput,
} from "./schema.ts";
async function requireAuthenticatedRequest() {
  const event = getRequestEvent();
  const user = event?.locals.identity as Identity | undefined;
  if (!event || !user || user.expires <= Date.now())
    throw new Response(null, { status: 401 });
  return {
    app: (await service()).app,
    user,
    signal: AbortSignal.any([
      event.request.signal,
      AbortSignal.timeout(Math.max(1, user.expires - Date.now())),
    ]),
  };
}
async function requireOwnedConversation(id: number) {
  const request = await requireAuthenticatedRequest();
  await request.app.requireConversationOwner(request.user.owner, id);
  return request;
}
function validatedInput<T>(result: T | type.errors): T {
  if (result instanceof type.errors) throw new Response(null, { status: 400 });
  return result;
}
export async function list() {
  const { app, user } = await requireAuthenticatedRequest();
  return app.list(user.owner);
}
export async function create() {
  const { app, user } = await requireAuthenticatedRequest();
  return app.create(user.owner);
}
export async function send(input: typeof sendInput.inferIn) {
  const { id, requestId, text } = validatedInput(sendInput(input));
  const { app, user } = await requireOwnedConversation(id);
  return app.send(id, requestId, text, user);
}
export async function stop(input: typeof stopInput.inferIn) {
  const { id, requestId } = validatedInput(stopInput(input));
  const { app } = await requireOwnedConversation(id);
  return app.stop(id, requestId);
}
export async function configure(input: typeof configureInput.inferIn) {
  const { id, settings } = validatedInput(configureInput(input));
  const { app } = await requireOwnedConversation(id);
  return app.configure(id, settings);
}
export async function watch(input: typeof conversation.inferIn) {
  const { id } = validatedInput(conversation(input));
  const { app, signal } = await requireOwnedConversation(id);
  return app.watch(id, signal);
}
