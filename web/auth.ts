import { UserManager, WebStorageStateStore } from "oidc-client-ts";
export async function login() {
  const { authority, client_id } = await (await fetch("/auth/config")).json();
  const manager = new UserManager({
    authority,
    client_id,
    redirect_uri: location.origin + "/callback",
    response_type: "code",
    scope: "openid",
    loadUserInfo: false,
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: sessionStorage }),
  });
  if (location.pathname === "/callback") {
    const u = await manager.signinRedirectCallback();
    const dest = String(u.state ?? "/");
    history.replaceState(null, "", /^\/c\/\d+$/.test(dest) ? dest : "/");
  }
  const u = await manager.getUser();
  if (!u || u.expired) {
    await manager.signinRedirect({ state: location.pathname });
    throw Error("redirecting");
  }
  return async (request: RequestInfo | URL, init?: RequestInit) => {
    const u = await manager.getUser();
    if (!u || u.expired) throw Error("login expired");
    const r = new Request(request, init);
    if (new URL(r.url).origin !== location.origin)
      throw Error("unexpected destination");
    r.headers.set("Authorization", "Bearer " + u.access_token);
    return fetch(r, { redirect: "error" });
  };
}
