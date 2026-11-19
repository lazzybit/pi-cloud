// Build a disposable realm; passwords and resource server secrets exist for one run only.
import { randomUUID } from "node:crypto";
export function realm(password, origin) {
  const scopes = ["execute", "persistent-volume", "egress-web"];
  return {
    realm: "fixture",
    enabled: true,
    sslRequired: "none",
    registrationAllowed: false,
    groups: [{ name: "runners" }, { name: "disk" }, { name: "network" }],
    users: ["first", "second"].map((username) => ({
      username,
      enabled: true,
      firstName: "Test",
      lastName: "Fixture",
      email: username + "@example.invalid",
      emailVerified: true,
      groups: ["/runners", "/disk"],
      credentials: [{ type: "password", value: password, temporary: false }],
    })),
    clients: [
      {
        clientId: "web",
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: [origin + "/callback"],
        webOrigins: [origin],
        attributes: { "pkce.code.challenge.method": "S256" },
        protocolMappers: [
          {
            name: "api audience",
            protocol: "openid-connect",
            protocolMapper: "oidc-audience-mapper",
            config: {
              "included.custom.audience": "api",
              "access.token.claim": "true",
              "id.token.claim": "false",
            },
          },
        ],
      },
      {
        clientId: "api",
        secret: randomUUID(),
        serviceAccountsEnabled: true,
        authorizationServicesEnabled: true,
        standardFlowEnabled: false,
        authorizationSettings: {
          allowRemoteResourceManagement: false,
          policyEnforcementMode: "ENFORCING",
          decisionStrategy: "UNANIMOUS",
          scopes: scopes.map((name) => ({ name })),
          resources: [
            { name: "sandbox", scopes: scopes.map((name) => ({ name })) },
          ],
          policies: [
            ...["runners", "disk", "network"].map((name) => ({
              name,
              type: "group",
              logic: "POSITIVE",
              decisionStrategy: "UNANIMOUS",
              config: {
                groups: JSON.stringify([
                  { path: "/" + name, extendChildren: false },
                ]),
              },
            })),
            ...scopes.map((name, i) => ({
              name: "allow " + name,
              type: "scope",
              logic: "POSITIVE",
              decisionStrategy: "UNANIMOUS",
              config: {
                resources: '["sandbox"]',
                scopes: JSON.stringify([name]),
                applyPolicies: JSON.stringify([
                  ["runners", "disk", "network"][i],
                ]),
              },
            })),
          ],
        },
      },
    ],
  };
}
