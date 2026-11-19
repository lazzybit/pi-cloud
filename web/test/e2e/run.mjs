import PG from "embedded-postgres";
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { apiPort, webPort, entry } from "./entry.mjs";
import { headless } from "./headless.mjs";
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
import { fake } from "./fake.mjs";
import { realm } from "./realm.mjs";
import { cluster } from "./cluster.mjs";
const dir = await mkdtemp(join(tmpdir(), "pi-e2e-")),
  password = randomUUID(),
  origin = "http://127.0.0.1:38443",
  issuer = "http://127.0.0.1:35323/realms/fixture",
  controllerKey = randomUUID();
const kcHome = process.env.KC_HOME;
if (!kcHome) throw Error("set KC_HOME to a disposable Keycloak distribution");
const model = fake(),
  pg = new PG({
    databaseDir: join(dir, "pg"),
    port: 35321,
    persistent: false,
    onLog: () => {},
  });
let kc, app, stopCluster, web, ingress;
const importDir = join(kcHome, "data/import");
try {
  await mkdir(importDir, { recursive: true });
  await writeFile(
    join(importDir, "fixture-realm.json"),
    JSON.stringify(realm(password, origin)),
    { mode: 0o600 },
  );
  kc = spawn(
    kcHome + "/bin/kc.sh",
    [
      "start-dev",
      "--http-host=127.0.0.1",
      "--http-port=35323",
      "--import-realm",
      "--db=dev-mem",
    ],
    {
      env: {
        ...process.env,
        KC_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
        KC_BOOTSTRAP_ADMIN_PASSWORD: password,
        JAVA_OPTS_APPEND: "-Xms64m -Xmx384m -XX:ActiveProcessorCount=2",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  await pg.initialise();
  await pg.start();
  model.listen(35322, "127.0.0.1");
  stopCluster = cluster(dir, controllerKey);
  for (const end = Date.now() + 120000; ; ) {
    if (
      await fetch(issuer + "/.well-known/openid-configuration")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    if (kc.exitCode !== null || Date.now() > end)
      throw Error("Keycloak did not become ready");
    await sleep(500);
  }
  const env = {
    ...process.env,
    PORT: String(apiPort),
    BIND: "127.0.0.1",
    PUBLIC_ORIGIN: `http://127.0.0.1:${apiPort}`,
    DATABASE_URL: "postgres://postgres:password@127.0.0.1:35321/postgres",
    MODEL_BASE_URL: "http://127.0.0.1:35322/v1",
    MODEL_ID: "fixture",
    MODEL_CHOICES: "fixture-alt",
    OIDC_ISSUER: issuer,

    OIDC_AUDIENCE: "api",
    CONTROLLER_URL: "http://127.0.0.1:35325",
    CONTROLLER_KEY: controllerKey,
  };
  const launch = async () => {
    const image = process.env.HARNESS_IMAGE;
    app = image
      ? spawn(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            "pi-writer-test",
            "--network",
            "host",
            ...Object.keys(env)
              .filter((k) =>
                [
                  "PORT",
                  "BIND",
                  "PUBLIC_ORIGIN",
                  "DATABASE_URL",
                  "MODEL_BASE_URL",
                  "MODEL_ID",
                  "MODEL_CHOICES",
                  "OIDC_ISSUER",

                  "OIDC_AUDIENCE",
                  "CONTROLLER_URL",
                  "CONTROLLER_KEY",
                ].includes(k),
              )
              .flatMap((k) => ["-e", k]),
            image,
          ],
          { env, stdio: ["ignore", "pipe", "inherit"] },
        )
      : spawn(process.execPath, ["harness/dist/server.mjs"], {
          env,
          stdio: ["ignore", "pipe", "inherit"],
        });
    await Promise.race([
      once(app.stdout, "data"),
      once(app, "exit").then(() => {
        throw Error("writer failed to start");
      }),
    ]);
    await writeFile(dir + "/writer.pid", String(app.pid));
  };
  await launch();
  await headless({ dir, issuer, password });
  const webEnv = {
    ...process.env,
    PORT: String(webPort),
    BIND: "127.0.0.1",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "web",
  };
  web = process.env.WEB_IMAGE
    ? spawn(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "host",
          "--name",
          "pi-spa-test",
          "-e",
          "PORT",
          "-e",
          "BIND",
          "-e",
          "OIDC_ISSUER",
          "-e",
          "OIDC_CLIENT_ID",
          process.env.WEB_IMAGE,
        ],
        { env: webEnv },
      )
    : spawn(process.execPath, ["web/server.mjs"], { env: webEnv });
  for (const end = Date.now() + 15000; ; ) {
    if (
      await fetch(`http://127.0.0.1:${webPort}/`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    if (Date.now() > end) throw Error("web not ready");
    await sleep(100);
  }
  ingress = entry();
  const test = spawn(
    "web/test/e2e/node_modules/.bin/playwright",
    [
      "test",
      "--config=web/test/e2e/playwright.config.ts",
      ...process.argv.slice(2),
    ],
    {
      env: {
        ...process.env,
        PI_E2E_ORIGIN: origin,
        PI_E2E_PASSWORD: password,
        PI_E2E_DIR: dir,
        PI_E2E_ISSUER: issuer,
        PI_E2E_CONTAINER: env.HARNESS_IMAGE ? "1" : "",
      },
      stdio: "inherit",
    },
  );
  let done = false;
  const result = once(test, "exit").then(([code]) => {
    done = true;
    return code ?? 1;
  });
  while (!done) {
    if (app.exitCode !== null || app.signalCode !== null) await launch();
    await sleep(100);
  }
  process.exitCode = await result;
} finally {
  ingress?.close();
  web?.kill();
  stopCluster?.();
  if (process.env.HARNESS_IMAGE) {
    const c = spawn("docker", ["rm", "-f", "pi-writer-test"], {
      stdio: "ignore",
    });
    await once(c, "exit");
  }
  app?.kill();
  kc?.kill();
  model.closeAllConnections();
  model.close();
  await pg.stop();
  await rm(join(importDir, "fixture-realm.json"), { force: true });
  await rm(dir, { recursive: true, force: true });
}
