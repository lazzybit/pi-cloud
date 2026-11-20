import { createModels, createProvider, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { type } from "arktype";
import type { Snapshot } from "../web/schema.ts";

const modelList = type({
  data: type({
    id: "1 <= string <= 128",
    "supportsReasoningEffort?": "boolean",
    "reasoningEfforts?": type({ value: "string" }).array(),
  }).array(),
});
const explicitLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function gateway(url: string) {
  const baseUrl = url.replace(/\/+$/, "");
  const models = createModels();
  let choices: Snapshot["models"] = [];

  async function refresh() {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`agentgateway model list HTTP ${response.status}`);
    const list = modelList(await response.json());
    if (list instanceof type.errors) throw new Error("Invalid agentgateway model list");
    const discovered = new Map<string, (typeof list.data)[number]>();
    for (const entry of list.data)
      if (!discovered.has(entry.id)) discovered.set(entry.id, entry);

    const provider = createProvider({
      id: "agentgateway",
      name: "agentgateway",
      baseUrl,
      auth: {
        apiKey: {
          name: "Mesh identity",
          resolve: async () => ({
            auth: { apiKey: "mesh" },
            source: "mesh identity",
          }),
        },
      },
      models: [...discovered.values()].map(({ id, supportsReasoningEffort, reasoningEfforts }) => {
        const catalogModel = Object.hasOwn(OPENAI_MODELS, id)
          ? OPENAI_MODELS[id as keyof typeof OPENAI_MODELS]
          : undefined;
        const offered = reasoningEfforts?.map(({ value }) => value);
        const levels = offered
          ? Object.fromEntries(explicitLevels.map((level) => [level, offered.includes(level) ? level : null]))
          : catalogModel?.thinkingLevelMap;
        return {
          id,
          name: id,
          api: "openai-responses",
          provider: "agentgateway",
          baseUrl,
          reasoning: supportsReasoningEffort !== false && (offered !== undefined || catalogModel?.reasoning === true),
          // "Model default" omits the wire field rather than sending a disable value.
          thinkingLevelMap: { ...levels, off: null },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64000,
          maxTokens: 4096,
        } as const;
      }),
      api: openAIResponsesApi(),
    });
    models.setProvider(provider);
    choices = provider.getModels().map((model) => ({
      id: model.id,
      efforts: ["default", ...getSupportedThinkingLevels(model).filter((level) => level !== "off")],
    }));
  }

  return {
    models,
    refresh,
    get choices() { return choices; },
  };
}
