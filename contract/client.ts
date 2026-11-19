import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { contract } from "./contract.ts";
export const connect = (
  origin: string,
  transport: typeof fetch = fetch,
): ContractRouterClient<typeof contract> =>
  createORPCClient(
    new OpenAPILink(contract, {
      url: `${origin}/api/v1`,
      fetch: (request, init) => transport(request, init),
    }),
  );
