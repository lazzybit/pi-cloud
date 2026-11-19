import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
export function trustedUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" &&
    !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))
  )
    throw Error("HTTPS required");
  return u;
}
export function verifier(issuer: string, audience: string) {
  const keys = createRemoteJWKSet(
    trustedUrl(issuer + "/protocol/openid-connect/certs"),
  );
  return async (header?: string) => {
    if (!header?.startsWith("Bearer ")) throw Error("missing access token");
    const token = header.slice(7);
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    if (!payload.sub || payload.typ !== "Bearer")
      throw Error("expected Keycloak access token");
    return {
      owner: createHash("sha256")
        .update(JSON.stringify([issuer, payload.sub]))
        .digest("hex"),
      token,
      expires: Number(payload.exp) * 1000,
    };
  };
}
export type Identity = Awaited<ReturnType<ReturnType<typeof verifier>>>;
export async function permissions(token: string) {
  const response = await fetch(
    trustedUrl(process.env.OIDC_ISSUER! + "/protocol/openid-connect/token"),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { authorization: "Bearer " + token },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:uma-ticket",
        audience: process.env.OIDC_AUDIENCE!,
        permission: "sandbox",
        response_mode: "permissions",
      }),
    },
  );
  if (response.status === 403) return null;
  if (!response.ok) throw Error("current sandbox decision unavailable");
  const list = await response.json();
  const scopes = new Set<string>(
    (list as { rsname: string; scopes?: string[] }[])
      .filter((p) => p.rsname === "sandbox")
      .flatMap((p) => p.scopes ?? []),
  );
  return scopes.has("execute")
    ? { volume: scopes.has("persistent-volume"), web: scopes.has("egress-web") }
    : null;
}
