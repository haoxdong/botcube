import type { AgentModel } from "./conversations";

const MODEL_VERSION = /^(?:openai-plan:)?(?:gpt-(\d+(?:\.\d+)*)-(sol|astra)|(opus|deepseek)-v?(\d+(?:\.\d+)*))$/i;

export function pickerModels(models: AgentModel[], families: readonly string[] | undefined): AgentModel[] {
  if (families === undefined) return models;
  return families.flatMap((family) => {
    const candidates = models.flatMap((model) => {
      const match = MODEL_VERSION.exec(model.key) ?? MODEL_VERSION.exec(model.label.replaceAll(" ", "-"));
      return match && (match[2] ?? match[3])?.toLowerCase() === family
        ? [{ model, version: (match[1] ?? match[4] ?? "").split(".").map(Number) }]
        : [];
    });
    candidates.sort((a, b) => compareVersions(b.version, a.version));
    return candidates[0] === undefined ? [] : [candidates[0].model];
  });
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
