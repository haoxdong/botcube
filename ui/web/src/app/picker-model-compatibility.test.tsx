import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelEffortPicker } from "./model-effort-picker";
import { useModelSelection } from "./model-selection";
import { modelChoices } from "./scheduled-task-draft";

vi.mock("@cartridge-ui", () => ({ webUiPlugin: { config: { pickerModelFamilies: ["sol", "astra", "opus", "deepseek"] } } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const models = [
  { key: "openai-plan:gpt-6-luna", label: "GPT-6-Luna", provider: "openai" },
  { key: "openai-plan:gpt-6.1-sol", label: "GPT-6.1-Sol", provider: "openai" },
  { key: "openai-plan:gpt-6-sol", label: "GPT-6-Sol", provider: "openai" },
];

it("keeps an older selected chat model while hiding it from choices", async () => {
  const onModelChange = vi.fn();
  render(<ModelEffortPicker models={{ loaded: true, accountId: "account", models }} model={models[0]?.key} effort="medium" loadingLabel={undefined} onModelChange={onModelChange} onEffortChange={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Model GPT-6-Luna, reasoning Medium" }));
  expect(screen.queryByRole("button", { name: "GPT-6-Luna" })).toBeNull();
  expect(screen.queryByRole("button", { name: "GPT-6-Sol" })).toBeNull();
  expect(onModelChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "GPT-6.1-Sol" }));
  expect(onModelChange).toHaveBeenCalledWith("openai-plan:gpt-6.1-sol");
});

it("retains an older task's current value without offering hidden models for a new choice", () => {
  const task = { id: "task", title: "Brief", prompt: "Brief me", schedule: "rate(1 day)", timezone: "UTC", paused: false, ended: false, sideChat: null, proposalId: "proposal", model: "openai-plan:gpt-6-luna" };
  expect(modelChoices(task, models, false, task.model, ["sol", "astra", "opus", "deepseek"])).toEqual([
    { value: "openai-plan:gpt-6-luna", label: "GPT-6-Luna", disabled: true },
    { value: "openai-plan:gpt-6.1-sol", label: "GPT-6.1-Sol" },
  ]);
});

it("defaults new chats to the newest Sol while preserving a saved older choice", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models })));
  const options = { ready: true, accountId: "account", activeProvider: undefined, showWelcome: true, chatServiceUrl: "http://chat.test" };
  const fresh = renderHook(() => useModelSelection(options));
  await waitFor(() => expect(fresh.result.current.properties.model).toBe("openai-plan:gpt-6.1-sol"));
  fresh.unmount();
  localStorage.setItem("botcube.picker-choice", JSON.stringify({ account: "account", model: "openai-plan:gpt-6-luna" }));
  const saved = renderHook(() => useModelSelection(options));
  await waitFor(() => expect(saved.result.current.catalog.loaded).toBe(true));
  expect(saved.result.current.properties.model).toBe("openai-plan:gpt-6-luna");
});
