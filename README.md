# Pi Cloud

A recoverable chat agent built on pi-durable and PostgreSQL. The Solid Web client and future TUI share the oRPC contract. Closing a tab drops its subscription, not the turn. Tool details are collapsed by default; expand one to inspect arguments, progress, output and exit status.

- **`contract/`, `web/`, `harness/` → `pi-cloud-harness`**: compiled SPA and API in one image. One PostgreSQL session-lock owner serves requests. Snapshots reconcile after reconnect; model calls can be repeated during recovery.
- **`sandbox/` → `pi-cloud-sandbox`**: disposable Linux worker. A per-Pod credential and boot identity bind command dispatch. The writer records intent before sending a command; recovery observes that call or reports an unknown outcome, never resubmits it.
- **`sandbox-controller/` → `pi-cloud-sandbox-controller`**: internal Kubernetes Pod/PVC lifecycle API. No shell commands, prompts or model credentials in controller requests. No StatefulSet or CRD.

## Identity and authorization

Configure one Keycloak realm, a public Web client (authorization code + S256 PKCE), and a separate API audience. Permit only the application origin and exact `/callback` redirect URI. Configure admission in IAM: issue the API audience **only to users admitted to Pi**. Possession of that audience gives access to personal chat, not other users' conversations. The harness verifies signed Keycloak access tokens; the identity key hashes `(issuer, sub)`, never email. The SPA bootstrap is public, not conversation data. All conversation APIs including watch verify ownership.

Configure a `sandbox` resource with scopes `execute`, `persistent-volume` and `egress-web` in Keycloak Authorization Services. Policies live in IAM. Use live group membership rather than a Groups Claim from an old access token. `tests/e2e/realm.mjs` illustrates the model with disposable accounts, **not** production admission settings. A deduplicated prompt warms the Pod asynchronously. The harness requests fresh permissions as the original user before warm-up and each command, and checks the binding again after readiness. IAM failure denies new execution. User tokens stay in process memory, never inside a Pod or the journal: a recovered turn can observe an accepted action, but cannot dispatch new commands until it has a valid user authorization. Expired credentials do not transfer to the service account.

## Deployment contract

Keep environment manifests and credentials outside this repo. Use a fresh database; importing ownerless preview conversations is not supported. Terminate HTTPS at a trusted ingress; restrict the HTTP backend to that ingress. No browser client certificate is required. Never expose the controller or workers to the public network. Require encrypted, authenticated workload transport (e.g. a mesh) and enforced internal ingress policy: the worker credential, Pod address and controller credential must travel only between the intended workloads. Do not enable shell access for mutually untrusted users on a shared kernel.

- Harness environment: `PUBLIC_ORIGIN`, `OIDC_ISSUER` (Keycloak realm URL), `OIDC_CLIENT_ID`, `OIDC_AUDIENCE`, `DATABASE_URL`, `MODEL_BASE_URL` (OpenAI-compatible endpoint, e.g. agentgateway using workload identity), `MODEL_ID`, optional `MODEL_CHOICES`. Set `CONTROLLER_URL` and `CONTROLLER_KEY` only to enable sandboxes. Port defaults to 8080. The harness needs no Kubernetes API credentials.
- Controller: run **one replica** in a dedicated sandbox namespace, port 8081, with a mounted service account. Grant Pod get/list/create/patch/delete and PVC get/create only. Use a strong random `CONTROLLER_KEY` shared with the harness, an immutable `SANDBOX_IMAGE` digest, optional `STORAGE_CLASS`, `VOLUME_SIZE`, `RUNTIME_CLASS`, `PROFILE_REVISION`, `IDLE_SECONDS` (default 600). Change the profile revision when external security/egress policies change. Do not grant other workloads permission to modify these Pods or PVCs.
- Disposable Pods run as non-root without a Kubernetes token, with no capabilities, a read-only root and a kernel-enforced command guard. `execute` alone gives temporary storage and no proxy. Personal volumes require a CSI driver supporting `ReadWriteOncePod`; the writable claim is not owned by any Pod. The optional Unix socket proxy allows public IPv4 Web destinations on 80/443 only. Limit namespace quotas, PID counts, internal ingress and egress at the cluster boundary as well. This is **not VM isolation**.
- Whether capacity is reused depends on the subject, Pod UID, effective grants, volume UID, image digest and security profile. Idle expiry starts at completion; abandoned reservations use a bounded grace interval. Revocation is checked before dispatch, not a continuous promise to terminate commands already running. The worker bounds each command to 30 seconds.

## Development and CI

Use non-root Linux, Node 26, a C compiler, Python 3.11+, and Landlock ABI 3+ with seccomp. Run `npm ci && npm run guard && npm run check && npm test`. `npm run build` writes the SPA to `web/dist/` and the server to `harness/dist/`. Web dependencies, Vite and JSX configuration live in `web/`; build just the SPA with `npm run build -w web`. For `npm run e2e`, install Chromium (`npx playwright install chromium`) and point `KC_HOME` at a **fresh disposable** Keycloak 26.4.7 distribution, with Java 21 on PATH or `JAVA_HOME`. The test starts loopback-only Keycloak, temporary PostgreSQL, a streaming fake model, and guarded workers. The local Kubernetes API fixture is not a CSI or cluster isolation test.

PRs test without registry write credentials. Main builds native arm64 candidates, tests them and publishes the same saved images to GHCR tagged by full Git SHA. Deploy by digest, not a moving tag. Product CI does not use a production kubeconfig. The controller still needs qualification on the intended kernel, mesh and CSI before rollout.

## Roadmap

- MicroVM driver with explicit VM boundaries; never silently substitute an ordinary Pod for a VM profile.
- TUI, Code Mode and MCP support; database primary failover and rollout compatibility qualification.
