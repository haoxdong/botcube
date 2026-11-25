import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSelector } from "./model-selector";
import { useModelSelection } from "./model-selection";
import { modelChoices } from "./scheduled-task-draft";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const models = [
  { key: "openai-plan:gpt-6.2-astra", label: "GPT-6.2-Astra", provider: "openai" },
  { key: "openai-plan:gpt-6.2-sol", label: "GPT-6.2-Sol", provider: "openai" },
  { key: "opus-5.5", label: "Opus 5.5", provider: "anthropic" },
];

it("shows models in server order and lets the user pick Bedrock", async () => {
  const onModelChange = vi.fn();
  render(<ModelSelector models={{ loaded: true, accountId: "account", models }} model={models[0]?.key} effort="medium" loadingLabel={undefined} onModelChange={onModelChange} onEffortChange={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Model GPT-6.2-Astra, reasoning Medium" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Model GPT-6.2-Astra" }));
  await screen.findByRole("listbox");
  expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label") ?? option.textContent)).toEqual(models.map(({ label }) => label));
  await userEvent.click(screen.getByRole("option", { name: "Opus 5.5" }));
  expect(onModelChange).toHaveBeenCalledWith("opus-5.5");
});

it("shows an older task's removed model as unavailable", () => {
  const task = { id: "task", title: "Brief", prompt: "Brief me", schedule: "rate(1 day)", timezone: "UTC", paused: false, ended: false, sideChat: null, proposalId: "proposal", model: "sonnet-4.6" };
  expect(modelChoices(task, models, task.model)).toEqual([
    { value: "sonnet-4.6", label: "sonnet-4.6 (unavailable)", disabled: true },
    ...models.map(({ key, label }) => ({ value: key, label })),
  ]);
});

it("defaults a stale choice and preserves an available saved choice", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models })));
  const options = { ready: true, accountId: "account", chatServiceUrl: "http://chat.test" };
  localStorage.setItem("botcube.picker-choice", JSON.stringify({ account: "account", model: "sonnet-4.6" }));
  const fresh = renderHook(() => useModelSelection(options));
  expect(fresh.result.current.properties.model).toBeUndefined();
  await waitFor(() => expect(fresh.result.current.properties.model).toBe("openai-plan:gpt-6.2-astra"));
  fresh.unmount();
  localStorage.setItem("botcube.picker-choice", JSON.stringify({ account: "account", model: "openai-plan:gpt-6.2-sol" }));
  const saved = renderHook(() => useModelSelection(options));
  await waitFor(() => expect(saved.result.current.catalog.loaded).toBe(true));
  expect(saved.result.current.properties.model).toBe("openai-plan:gpt-6.2-sol");
});
