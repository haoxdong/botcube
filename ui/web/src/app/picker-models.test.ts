import { describe, expect, it } from "vitest";
import { pickerModels } from "./picker-models";

const families = ["sol", "astra", "opus", "deepseek"];
const model = (key: string) => ({ key, label: key, provider: "test" });

describe("picker models", () => {
  it("offers the highest numeric version per family without changing the catalog", () => {
    const keys = ["openai-plan:gpt-6.9-sol", "openai-plan:gpt-6-astra", "opus-4.6", "deepseek-v3.2", "sonnet-5.5", "haiku-4.5", "openai-plan:gpt-6.1-terra", "openai-plan:gpt-6-luna", "openai-plan:gpt-6.10-sol", "opus-5.5", "openai-plan:gpt-5.6-astra"];
    const catalog = keys.map(model);
    expect(pickerModels(catalog, families).map(({ key }) => key)).toEqual(["openai-plan:gpt-6.10-sol", "openai-plan:gpt-6-astra", "opus-5.5", "deepseek-v3.2"]);
    expect(catalog.map(({ key }) => key)).toEqual(keys);
  });

  it("keeps other cartridges' models and allows missing families", () => {
    const echo = [model("echo")];
    expect(pickerModels(echo, undefined)).toEqual(echo);
    expect(pickerModels(echo, families)).toEqual([]);
    expect(pickerModels([model("opus-4.6")], families)).toEqual([model("opus-4.6")]);
  });
});
