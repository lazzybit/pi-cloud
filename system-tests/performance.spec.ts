import { test, expect, chromium } from "@playwright/test";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
test("mobile Lighthouse on an authenticated conversation", async () => {
  test.setTimeout(120000);
  const chrome = await launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${chrome.port}`,
    );
    const page = await browser.contexts()[0].newPage();
    const origin = process.env.PI_E2E_ORIGIN!;
    await page.goto(origin);
    await page.locator("[name=username]").fill("first");
    await page.locator("[name=password]").fill(process.env.PI_E2E_PASSWORD!);
    await page.locator("[type=submit]").click();
    await expect(page.getByRole("button", { name: "新對話" })).toBeEnabled();
    await page.getByRole("button", { name: "新對話" }).click();
    await expect(page.getByLabel("訊息")).toBeEnabled();
    const url = page.url();
    expect(url).toMatch(/\/c\/\d+$/);
    await page.close();
    const result = await lighthouse(url, {
      port: chrome.port,
      logLevel: "error",
      onlyCategories: ["performance", "accessibility"],
      disableStorageReset: true,
    });
    if (!result || result.lhr.runtimeError)
      throw Error("Lighthouse did not measure chat");
    const l = result.lhr;
    expect(l.finalDisplayedUrl).toBe(url);
    expect(l.audits["document-title"].score).toBe(1);
    const perf = l.categories.performance.score!,
      a11y = l.categories.accessibility.score!,
      lcp = l.audits["largest-contentful-paint"].numericValue!,
      cls = l.audits["cumulative-layout-shift"].numericValue!,
      tbt = l.audits["total-blocking-time"].numericValue!;
    console.log(
      "Lighthouse mobile",
      JSON.stringify({ perf, a11y, lcp, cls, tbt }),
    );
    expect(perf).toBeGreaterThanOrEqual(0.9);
    expect(cls).toBeLessThanOrEqual(0.1);
    expect(lcp).toBeLessThanOrEqual(2500);
    expect(tbt).toBeLessThanOrEqual(200);
  } finally {
    await chrome.kill();
  }
});
