import { invoke } from "@solidjs/web/server-functions";
import { watch } from "./rpc.ts";
export { create, send, configure, stop } from "./rpc.ts";
export const subscribe = (id: number, signal: AbortSignal) =>
  invoke(watch, { signal }, { id });
