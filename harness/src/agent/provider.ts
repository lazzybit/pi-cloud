import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
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
      models: ids.map(
        (id) =>
          ({
            id,
            name: id,
            api: "openai-completions",
            provider: "agentgateway",
            baseUrl,
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64000,
            maxTokens: 4096,
          }) as const,
      ),
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
