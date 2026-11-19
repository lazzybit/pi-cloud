export interface Config {
  image: string;
  runtimeClass?: string;
  revision?: string;
  storageClass?: string;
  size?: string;
}
export interface Grants {
  volume: boolean;
  web: boolean;
}
export interface Metadata {
  name: string;
  uid: string;
  resourceVersion: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  deletionTimestamp?: string;
}
export interface Pod {
  metadata: Metadata;
  spec: { containers: { env?: { name: string; value?: string }[] }[] };
  status?: {
    phase?: string;
    podIP?: string;
    conditions?: { type: string; status: string }[];
  };
}
export type KubeRequest = <T>(
  path: string,
  method?: "GET" | "POST" | "DELETE" | "PATCH",
  body?: object,
) => Promise<T>;
export type LifecycleRequest = { owner: string; id: string } & (
  | { action: "warm" | "acquire"; grants: Grants }
  | { action: "check"; grants: Grants; uid: string }
  | { action: "release"; uid: string }
  | { action: "lookup"; uid: string }
  | { action: "fence" }
);
export function parseRequest(input: unknown): LifecycleRequest {
  if (!input || typeof input !== "object") throw Error("invalid request");
  const { action, owner, id, grants, uid } = input as Record<string, unknown>;
  if (
    typeof owner !== "string" ||
    !/^[a-f0-9]{64}$/.test(owner) ||
    typeof id !== "string" ||
    id.length > 160
  )
    throw Error("invalid request");
  if (action === "fence") return { action, owner, id };
  if (action === "release" || action === "lookup") {
    if (typeof uid === "string") return { action, owner, id, uid };
  } else if (
    grants &&
    typeof grants === "object" &&
    "volume" in grants &&
    typeof grants.volume === "boolean" &&
    "web" in grants &&
    typeof grants.web === "boolean"
  ) {
    const g = { volume: grants.volume, web: grants.web };
    if (action === "warm" || action === "acquire")
      return { action, owner, id, grants: g };
    if (action === "check" && typeof uid === "string")
      return { action, owner, id, grants: g, uid };
  }
  throw Error("invalid request");
}
