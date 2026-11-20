import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
export function gateway(baseUrl: string, ids: string[]) {
  const models = createModels();
  models.setProvider(
    createProvider({
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
      models: ids.map((id) => {
        const catalogModel = Object.hasOwn(OPENAI_MODELS, id)
          ? OPENAI_MODELS[id as keyof typeof OPENAI_MODELS]
          : undefined;
        // Keep the existing low/medium/high options for gateway-only IDs.
        const levels = catalogModel ? catalogModel.thinkingLevelMap : { minimal: null };
        return {
          id,
          name: id,
          api: "openai-completions",
          provider: "agentgateway",
          baseUrl,
          reasoning: catalogModel?.reasoning ?? true,
          // "Model default" omits the wire field rather than sending a disable value.
          thinkingLevelMap: { ...levels, off: null },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64000,
          maxTokens: 4096,
        } as const;
      }),
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
