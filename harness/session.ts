import * as oidc from "openid-client";
import { CompactEncrypt, compactDecrypt } from "jose";
import { randomBytes, createHash } from "node:crypto";
import { trustedUrl, verifier } from "./auth.ts";
import { service } from "./service.ts";
const origin = () => trustedUrl(process.env.PUBLIC_ORIGIN!).origin;
const cookieName = (name: string) =>
  (origin().startsWith("https:") ? "__Host-" : "") + "pi-" + name;
const cookie = (name: string, value: string, age: number) =>
  `${cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin().startsWith("https:") ? "; Secure" : ""}`;
const read = (r: Request, name: string) =>
  r.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((x) => x.startsWith(cookieName(name) + "="))
    ?.split("=")[1] ?? "";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let discovery: ReturnType<typeof oidc.discovery> | undefined;
function config() {
  const issuer = trustedUrl(process.env.OIDC_ISSUER!);
  return (discovery ??= oidc
    .discovery(issuer, process.env.OIDC_CLIENT_ID!, undefined, oidc.None(), {
      execute: issuer.protocol === "http:" ? [oidc.allowInsecureRequests] : [],
    })
    .catch((e) => {
      discovery = undefined;
      throw e;
    }));
}
let verify: ReturnType<typeof verifier> | undefined;
const identity = (token: string) =>
  (verify ??= verifier(process.env.OIDC_ISSUER!, process.env.OIDC_AUDIENCE!))(
    "Bearer " + token,
  );
export async function begin(path: string) {
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const dest = /^\/c\/\d+$/.test(path) ? path : "/";
  const state = hash(verifier + dest);
  const url = oidc.buildAuthorizationUrl(await config(), {
    redirect_uri: origin() + "/callback",
    scope: "openid",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: url.href,
      "set-cookie": cookie(
        "login",
        verifier + "." + encodeURIComponent(dest),
        300,
      ),
      "cache-control": "no-store",
    },
  });
}
export async function callback(r: Request) {
  const [v, d] = read(r, "login").split(".");
  if (!v || !d) throw Error("login expired");
  const dest = decodeURIComponent(d);
  if (dest !== "/" && !/^\/c\/\d+$/.test(dest))
    throw Error("invalid return path");
  const url = new URL("/callback" + new URL(r.url).search, origin());
  const tokens = await oidc.authorizationCodeGrant(await config(), url, {
    pkceCodeVerifier: v,
    expectedState: hash(v + dest),
  });
  const who = await identity(tokens.access_token);
  const key = randomBytes(32),
    handle = key.toString("base64url");
  const sealed = await new CompactEncrypt(Buffer.from(who.token))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(key);
  const { db } = await service();
  await db
    .deleteFrom("pi_session")
    .where("expires", "<=", Date.now())
    .execute();
  await db
    .insertInto("pi_session")
    .values({ id: hash(handle), sealed, expires: who.expires })
    .execute();
  const res = new Response(null, {
    status: 303,
    headers: { location: origin() + dest, "cache-control": "no-store" },
  });
  res.headers.append(
    "set-cookie",
    cookie("session", handle, Math.floor((who.expires - Date.now()) / 1000)),
  );
  res.headers.append("set-cookie", cookie("login", "", 0));
  return res;
}
export async function session(r: Request) {
  const handle = read(r, "session");
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) return;
  const { db } = await service();
  const row = await db
    .selectFrom("pi_session")
    .select("sealed")
    .where("id", "=", hash(handle))
    .where("expires", ">", Date.now())
    .executeTakeFirst();
  if (!row) return;
  const { plaintext } = await compactDecrypt(
    row.sealed,
    Buffer.from(handle, "base64url"),
  );
  return identity(Buffer.from(plaintext).toString());
}
