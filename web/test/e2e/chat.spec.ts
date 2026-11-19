import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { permissions } from "../../../harness/auth.ts";
async function login(page: Page, user = "first") {
  await page.goto("/");
  await page.locator("[name=username]").fill(user);
  await page.locator("[name=password]").fill(process.env.PI_E2E_PASSWORD!);
  await page.locator("[type=submit]").click();
  await expect(page.getByRole("button", { name: "新對話" })).toBeEnabled();
}
async function token(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(
        sessionStorage.getItem(
          Object.keys(sessionStorage).find((k) => k.startsWith("oidc.user:"))!,
        )!,
      ).access_token as string,
  );
}
test("PKCE login, stream, reload, stop and durable settings", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/v1/conversations")).status()).toBe(401);
  await login(page);
  await page.getByRole("button", { name: "新對話" }).click();
  await page.getByLabel("模型", { exact: true }).selectOption("fixture-alt");
  await page.getByLabel("思考強度").selectOption("high");
  await expect(page.getByLabel("思考強度")).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel("思考強度")).toHaveValue("high");
  await page.getByLabel("訊息").fill("inspect settings");
  await page.getByLabel("訊息").press("Enter");
  await expect(page.getByTestId("partial")).toContainText("Test");
  await page.reload();
  await expect(page.locator("[data-role=assistant]")).toContainText(
    "fixture-alt:high",
  );
  await page.getByLabel("訊息").fill("stop me");
  await page.getByLabel("訊息").press("Enter");
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByRole("status")).toHaveText("stopped");
});
test("second OIDC subject cannot list, watch or mutate first conversation", async ({
  page,
  browser,
  request,
}) => {
  await login(page);
  const id = page.url().split("/").pop();
  const other = await browser.newPage({ baseURL: process.env.PI_E2E_ORIGIN });
  try {
    await login(other, "second");
    const headers = { authorization: "Bearer " + (await token(other)) },
      base = "/api/v1/conversations";
    expect(await (await request.get(base, { headers })).json()).not.toContain(
      Number(id),
    );
    for (const [method, suffix, data] of [
      ["GET", "watch", undefined],
      ["POST", "stop", { requestId: crypto.randomUUID() }],
      ["POST", "turns", { requestId: crypto.randomUUID(), text: "forbidden" }],
      ["PUT", "settings", { settings: { model: "fixture", effort: "low" } }],
    ] as const) {
      expect(
        (
          await request.fetch(`${base}/${id}/${suffix}`, {
            headers,
            method,
            data,
          })
        ).status(),
      ).toBe(404);
    }
  } finally {
    await other.close();
  }
});
test("tool streams while collapsed, reload does not run it again", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "新對話" }).click();
  await page.getByLabel("訊息").fill("fixture tool progress");
  await page.getByLabel("訊息").press("Enter");
  const card = page.locator("details.tool-call"),
    summary = card.locator("summary");
  await expect(summary).toContainText("執行中", { timeout: 15000 });
  await expect(card).not.toHaveAttribute("open", "");
  await summary.click();
  await expect(card.locator("[data-stream=stdout]")).toHaveText("begin");
  await expect(summary).toContainText("失敗");
  await expect(card.locator("[data-stream=stderr]")).toHaveText("problem");
  await page.reload();
  await expect(summary).toContainText("失敗");
  await expect(card).not.toHaveAttribute("open", "");
});

test("Keycloak re-evaluates group removal even with the original access token", async ({
  page,
}) => {
  await login(page);
  const bearer = await token(page);
  const issuer = process.env.PI_E2E_ISSUER!,
    base = new URL(issuer).origin;
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_AUDIENCE = "api";
  expect(await permissions(bearer)).toEqual({ volume: true, web: false });
  const auth = await fetch(
    base + "/realms/master/protocol/openid-connect/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: "fixture-admin",
        password: process.env.PI_E2E_PASSWORD!,
      }),
    },
  );
  expect(auth.ok).toBe(true);
  const headers = {
    authorization: "Bearer " + (await auth.json()).access_token,
  };
  const admin = base + "/admin/realms/fixture";
  const users = await (
      await fetch(admin + "/users?username=first&exact=true", { headers })
    ).json(),
    groups = await (await fetch(admin + "/groups", { headers })).json();
  const group = groups.find((g: { name: string }) => g.name === "disk");
  const membership = `${admin}/users/${users[0].id}/groups/${group.id}`;
  try {
    expect((await fetch(membership, { method: "DELETE", headers })).ok).toBe(
      true,
    );
    expect(await permissions(bearer)).toEqual({ volume: false, web: false });
  } finally {
    expect((await fetch(membership, { method: "PUT", headers })).ok).toBe(true);
  }
});
test("writer loss observes existing call without a second side effect", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "新對話" }).click();
  await page.getByLabel("訊息").fill("fixture interrupted cmd");
  await page.getByLabel("訊息").press("Enter");
  const dir = process.env.PI_E2E_DIR!;
  const marker = () => {
    for (const e of readdirSync(dir)) {
      try {
        return readFileSync(`${dir}/${e}/claimed`, "utf8");
      } catch {}
    }
    return "";
  };
  await expect.poll(marker, { timeout: 12000 }).toBe("x");
  if (process.env.PI_E2E_CONTAINER)
    execFileSync("docker", ["kill", "pi-writer-test"]);
  else
    process.kill(Number(readFileSync(dir + "/writer.pid", "utf8")), "SIGKILL");
  await expect(page.locator("[data-role=assistant] p").last()).toContainText(
    "recovered-result",
    { timeout: 35000 },
  );
  expect(marker()).toBe("x");
});
