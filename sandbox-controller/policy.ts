import { createHash, randomBytes } from "node:crypto";
import type { Config, Grants } from "./types.ts";
export const hash = (s: unknown) =>
  createHash("sha256").update(JSON.stringify(s)).digest("hex");
export function profile(
  owner: string,
  grants: Grants,
  config: Config,
  claimUID: string | null = null,
) {
  if (
    !/^[a-f0-9]{64}$/.test(owner) ||
    !grants ||
    typeof grants.volume !== "boolean" ||
    typeof grants.web !== "boolean"
  )
    throw Error("invalid binding");
  if (!/@sha256:[0-9a-f]{64}$/.test(config.image))
    throw Error("require immutable image");
  const suffix = owner.slice(0, 48),
    claim = grants.volume ? "pv-" + suffix : null;
  const binding = hash([owner, claim, claimUID, grants.web, config]);
  return { name: "sb-" + suffix, claim, binding };
}
export function pod(
  bindingProfile: ReturnType<typeof profile>,
  grants: Grants,
  config: Config,
) {
  const { name, claim, binding } = bindingProfile;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      labels: { "app.kubernetes.io/managed-by": "pi-sandbox-controller" },
      annotations: { binding, activity: String(Date.now()) },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Never",
      ...(config.runtimeClass ? { runtimeClassName: config.runtimeClass } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65532,
        runAsGroup: 65532,
        fsGroup: 65532,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        {
          name: "data",
          ...(claim
            ? { persistentVolumeClaim: { claimName: claim } }
            : { emptyDir: { sizeLimit: "256Mi" } }),
        },
        { name: "tmp", emptyDir: { sizeLimit: "32Mi" } },
      ],
      containers: [
        {
          name: "sandbox",
          image: config.image,
          env: [
            { name: "EGRESS_WEB", value: grants.web ? "1" : "0" },
            { name: "RUNTIME_KEY", value: randomBytes(32).toString("hex") },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "50m", memory: "48Mi" },
            limits: { cpu: "1", memory: "256Mi" },
          },
          readinessProbe: { tcpSocket: { port: 8282 } },
          volumeMounts: [
            { name: "data", mountPath: "/workspace" },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
    },
  };
}
export function expired(
  annotations: Record<string, string>,
  now: number,
  idle: number,
) {
  return (
    now >=
    Math.max(Number(annotations.activity), Number(annotations.until || 0)) +
      idle
  );
}
