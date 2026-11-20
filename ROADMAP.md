# Roadmap

- **Optional sandbox egress isolation.** Support Pod-level outbound policy without assuming Istio, a particular CNI, or a service mesh. Evaluate how deployments can opt into modes such as no network or public Web only while standard clients connect directly. Before claiming isolation, verify that the chosen deployment policy blocks bypasses, including direct IPs, private networks and cloud metadata. Until then, sandbox commands inherit the deployment's network reachability.
- **MicroVM isolation** for sandbox workloads.
- **Code Mode** for tool use.
- **Database-primary failover qualification** for the durable harness.
