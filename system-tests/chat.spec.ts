import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { permissions } from "../harness/src/identity/auth.ts";
async function login(page: Page, user = "first") {
  await page.goto("/");
  await page.locator("[name=username]").fill(user);
  await page.locator("[name=password]").fill(process.env.PI_E2E_PASSWORD!);
  await page.locator("[type=submit]").click();
  await expect(page.getByRole("button", { name: "新對話" })).toBeEnabled();
}
test("anonymous page navigation starts login; RPC never redirects to login", async ({
  request,
}) => {
  const origin = process.env.PI_E2E_ORIGIN!;
  const navigation = await request.get("/c/7", { maxRedirects: 0 });
  expect(navigation.status()).toBe(302);
  expect(new URL(navigation.headers().location).pathname).toContain(
    "/protocol/openid-connect/auth",
  );
  const rpcPath = "/_server/data/missing";
  expect((await request.post(rpcPath, { headers: { origin } })).status()).toBe(
    401,
  );
  expect(
    (
      await request.post(rpcPath, {
        headers: { origin: "https://other.invalid" },
      })
    ).status(),
  ).toBe(403);
  expect((await request.get(rpcPath)).status()).toBe(403);
  expect((await request.get("/not-a-chat-page")).status()).toBe(404);
});
test("PKCE login, stream, reload, stop and durable settings", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "新對話" }).click();
  const model = page.getByLabel("模型", { exact: true });
  const effort = page.getByLabel("思考強度");
  await model.selectOption("gpt-5.2");
  await expect(effort.locator("option")).toHaveText([
    "模型預設", "低", "中", "高", "極高",
  ]);
  await effort.selectOption("xhigh");
  await expect(effort).toBeEnabled();
  await page.reload();
  await expect(effort).toHaveValue("xhigh");
  await page.getByLabel("訊息").fill("inspect settings");
  await page.getByLabel("訊息").press("Enter");
  await expect(page.getByTestId("partial")).toContainText("Test");
  await page.reload();
  await expect(page.locator("[data-role=assistant]")).toContainText("gpt-5.2:xhigh");
  await model.selectOption("gpt-4.1-mini");
  await expect(effort.locator("option")).toHaveText(["模型預設"]);
  await expect(effort).toHaveValue("default");
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
  await page.getByRole("button", { name: "新對話" }).click();
  await expect(page).toHaveURL(/\/c\/\d+$/);
  const id = Number(new URL(page.url()).pathname.split("/").pop());
  const other = await browser.newPage({ baseURL: process.env.PI_E2E_ORIGIN });
  try {
    await login(other, "second");
    expect((await other.request.get(`/c/${id}`)).status()).toBe(404);
    const rpcManifest = JSON.parse(
      readFileSync(
        "harness/dist/server/.vite/solid-server-functions.json",
        "utf8",
      ),
    ).functions as { name: string; id: string }[];
    const call = async (name: string, args: unknown[]) =>
      other.request.post(
        "/_server/" +
          rpcManifest.find((x) => x.name === name)!.id +
          "?args=" +
          encodeURIComponent(JSON.stringify(args)),
        { headers: { origin: process.env.PI_E2E_ORIGIN! } },
      );
    expect(await (await call("list", [])).json()).not.toContain(Number(id));
    for (const [name, input] of [
      ["watch", { id: Number(id) }],
      [
        "send",
        { id: Number(id), requestId: crypto.randomUUID(), text: "forbidden" },
      ],
      [
        "configure",
        { id: Number(id), settings: { model: "fixture", effort: "low" } },
      ],
      ["stop", { id: Number(id), requestId: crypto.randomUUID() }],
    ] as const)
      expect((await call(name, [input])).status(), name).toBe(404);
    expect((await call("send", [{ id: "bad" }])).status()).toBe(400);
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

test("a sandbox command uses native HTTP without a proxy or network grant", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "新對話" }).click();
  await page.getByLabel("訊息").fill("fixture native network");
  await page.getByLabel("訊息").press("Enter");
  const card = page.locator("details.tool-call"),
    summary = card.locator("summary");
  await expect(summary).toContainText("已完成", { timeout: 15000 });
  await summary.click();
  await expect(card.locator("[data-stream=stdout]")).toHaveText(
    "native HTTP fixture reached",
  );
  await expect(card.getByText("退出碼：0", { exact: true })).toBeVisible();
});

test("Keycloak re-evaluates group removal even with the original access token", async ({
  page,
}) => {
  await login(page);
  const response = await fetch(
    process.env.PI_E2E_ISSUER + "/protocol/openid-connect/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "terminal-fixture",
        username: "first",
        password: process.env.PI_E2E_PASSWORD!,
      }),
    },
  );
  expect(response.ok).toBe(true);
  const bearer = (await response.json()).access_token;
  const issuer = process.env.PI_E2E_ISSUER!,
    base = new URL(issuer).origin;
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_AUDIENCE = "api";
  expect(await permissions(bearer)).toEqual({ volume: true });
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
    expect(await permissions(bearer)).toEqual({ volume: false });
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
