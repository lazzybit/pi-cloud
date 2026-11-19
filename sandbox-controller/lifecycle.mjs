import { pod, profile, expired } from "./policy.mjs";
export function lifecycle(k, config, idle) {
  const label = "app.kubernetes.io/managed-by",
    managed = "pi-sandbox-controller";
  const locks = new Map();
  async function locked(name, f) {
    const prior = locks.get(name) ?? Promise.resolve(),
      op = prior.catch(() => {}).then(f);
    locks.set(name, op);
    try {
      return await op;
    } finally {
      if (locks.get(name) === op) locks.delete(name);
    }
  }
  const remove = (p) =>
    k("pods/" + p.metadata.name, "DELETE", {
      preconditions: {
        uid: p.metadata.uid,
        resourceVersion: p.metadata.resourceVersion,
      },
    });
  const mark = (p, annotations) =>
    k("pods/" + p.metadata.name, "PATCH", {
      metadata: { resourceVersion: p.metadata.resourceVersion, annotations },
    });
  async function act({ owner, grants, action, id, uid }) {
    if (
      !/^[a-f0-9]{64}$/.test(owner) ||
      !["warm", "acquire", "release", "lookup", "check", "fence"].includes(
        action,
      ) ||
      typeof id !== "string" ||
      id.length > 160
    )
      throw Error("invalid request");
    const name = "sb-" + owner.slice(0, 48);
    return locked(name, async () => {
      let p = await k("pods/" + name);
      if (p && p.metadata.labels?.[label] !== managed)
        throw Error("name collision");
      const a = p?.metadata.annotations ?? {},
        now = Date.now(),
        pending = { pending: true };
      if (action === "release") {
        if (p?.metadata.uid === uid && a.lease === id)
          await mark(p, { lease: null, until: null, activity: String(now) });
        return {};
      }
      if (action === "fence") {
        if (p && !p.metadata.deletionTimestamp) await remove(p);
        return {};
      }
      if (action === "lookup") {
        if (
          !p ||
          p.metadata.uid !== uid ||
          p.metadata.deletionTimestamp ||
          !p.status.podIP
        )
          return { missing: true };
        return endpoint(p);
      }
      if (p?.metadata.deletionTimestamp) return pending;
      let spec = profile(owner, grants, config);
      if (spec.claim) {
        let claim = await k("persistentvolumeclaims/" + spec.claim);
        if (!claim) {
          claim = await k("persistentvolumeclaims", "POST", {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: {
              name: spec.claim,
              labels: { [label]: managed },
              annotations: { owner },
            },
            spec: {
              accessModes: ["ReadWriteOncePod"],
              ...(config.storageClass
                ? { storageClassName: config.storageClass }
                : {}),
              resources: { requests: { storage: config.size } },
            },
          });
        }
        if (
          claim.metadata.annotations?.owner !== owner ||
          claim.metadata.deletionTimestamp
        )
          throw Error("invalid personal claim");
        spec = profile(owner, grants, config, claim.metadata.uid);
      }
      if (
        p &&
        (a.binding !== spec.binding ||
          ["Failed", "Succeeded"].includes(p.status?.phase))
      ) {
        await remove(p);
        return pending;
      }
      if (action === "check")
        return {
          valid:
            !!p &&
            p.metadata.uid === uid &&
            a.lease === id &&
            Number(a.until) > now,
        };
      if (!p) {
        await k("pods", "POST", pod(spec, grants, config));
        return pending;
      }
      if (
        !p.status.conditions?.some(
          (c) => c.type === "Ready" && c.status === "True",
        )
      )
        return pending;
      if (action === "warm") {
        if (a.lastWarm !== id)
          await mark(p, { activity: String(now), lastWarm: id });
        return { ready: true };
      }
      if (action === "acquire") {
        if (a.lease && a.lease !== id && Number(a.until) > now) return pending;
        await mark(p, { lease: id, until: String(now + 90000) });
      }
      return endpoint(p);
    });
  }
  function endpoint(p) {
    const ip = p.status.podIP;
    return {
      uid: p.metadata.uid,
      url: `http://${ip.includes(":") ? "[" + ip + "]" : ip}:8282`,
      key: p.spec.containers[0].env.find((e) => e.name === "RUNTIME_KEY").value,
    };
  }
  async function sweep() {
    try {
      const ps = await k(
        "pods?labelSelector=" + encodeURIComponent(label + "=" + managed),
      );
      await Promise.allSettled(
        ps.items.map((p) =>
          locked(p.metadata.name, async () => {
            const current = await k("pods/" + p.metadata.name);
            if (
              current?.metadata.uid === p.metadata.uid &&
              !current.metadata.deletionTimestamp &&
              expired(current.metadata.annotations, Date.now(), idle)
            )
              await remove(current);
          }),
        ),
      );
    } catch {
      console.warn("reconcile unavailable");
    }
  }
  return { act, sweep };
}
