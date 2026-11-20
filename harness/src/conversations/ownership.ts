import { defineDoc } from "@earendil-works/pi-durable";

export const ownershipKind = "pi-cloud.owner";
export const productOwner = defineDoc({
  kind: ownershipKind, scope: "conversation", history: "latest", fork: "initial",
  version: 1, initial: () => ({ subject: "" }), checkpointWhen: () => true,
});
