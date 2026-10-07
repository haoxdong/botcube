"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { webUiPlugin } from "@cartridge-ui";
import { fetchAgentModels, type AgentModel } from "./conversations";

const { config: UI_CONFIG } = webUiPlugin;

/** The account's models, or why they could not load (no reason while they load). */
export type ModelList = { loaded: true; accountId: string | undefined; models: AgentModel[] } | { loaded: false; error: string | null };

/** The model and effort the user last picked in this browser; the model belongs to the account it was picked on. */
interface PickerChoice {
  model?: string;
  account?: string | undefined;
  effort?: string;
}

const PICKER_CHOICE_KEY = "botcube.picker-choice";

function storedChoice(): PickerChoice {
  return JSON.parse(localStorage.getItem(PICKER_CHOICE_KEY) ?? "{}") as PickerChoice;
}

function storeChoice(change: PickerChoice) {
  localStorage.setItem(PICKER_CHOICE_KEY, JSON.stringify({ ...storedChoice(), ...change }));
}

const choiceNotKept = (error: unknown) =>
  `This browser could not keep your model choice: ${error instanceof Error ? error.message : String(error)}`;

/** The stored choice; a browser that blocks storage keeps none, so the picker starts from the defaults and says so. */
function readChoice(): { stored: PickerChoice; readError: string | null } {
  try {
    return { stored: storedChoice(), readError: null };
  } catch (error) {
    return { stored: {}, readError: choiceNotKept(error) };
  }
}

function offeredEffort(effort: string | undefined): string {
  const { effortLevels, defaultEffort } = UI_CONFIG.agentOptions;
  return effortLevels.find(({ key }) => key === effort)?.key ?? defaultEffort;
}

function modelInList(models: ModelList, selected: string | undefined): string | undefined {
  return models.loaded && !models.models.some(({ key }) => key === selected)
    ? models.models[0]?.key
    : selected;
}

/** The account's offered choice, including browser persistence and the Session's provider. */
export function useModelSelection({
  ready,
  accountId,
  activeProvider,
  showWelcome,
  chatServiceUrl,
}: {
  ready: boolean;
  accountId: string | undefined;
  activeProvider: string | undefined;
  showWelcome: boolean;
  chatServiceUrl: string;
}) {
  const [modelList, setModels] = useState<ModelList>({ loaded: false, error: null });
  const [model, setModel] = useState<string | undefined>(undefined);
  /** Whether the user picked the model, which an account's models keep when they include it; else they start on their first. */
  const modelChosen = useRef(false);
  /** The choice stored in this browser, whose model an account starts on only if it was picked there. */
  const [{ stored, readError }] = useState(readChoice);
  const [choiceError, setChoiceError] = useState(readError);
  /** Keep the choice in this browser; one that blocks storage says so, and the choice lasts until the page reloads. */
  const rememberChoice = (change: PickerChoice) => {
    try {
      storeChoice(change);
      setChoiceError(null);
    } catch (error) {
      setChoiceError(choiceNotKept(error));
    }
  };
  const [effort, setEffort] = useState(() => offeredEffort(stored.effort));
  // The new account renders before its models effect resets the previous account's loaded list.
  const models: ModelList = modelList.loaded && modelList.accountId !== accountId ? { loaded: false, error: null } : modelList;
  const modelsRequest = useRef(0);
  // The account's models, from the Chat Service; the selector keeps a chosen model they include, else starts on the first.
  useEffect(
    () => {
      if (!ready) return;
      const request = ++modelsRequest.current;
      // The previous account's models are not this one's.
      setModels({ loaded: false, error: null });
      fetchAgentModels({ chatServiceUrl }).then(
        (loaded) => {
          if (request !== modelsRequest.current) return;
          setModels({ loaded: true, accountId, models: loaded });
          // A model picked in this page stays the choice on the account the page moves to, after a reload too.
          if (modelChosen.current) rememberChoice({ account: accountId });
          else setModel(stored.account === accountId ? stored.model : undefined);
        },
        (error: Error) => {
          console.error(error);
          if (request === modelsRequest.current) setModels({ loaded: false, error: `Models could not load: ${error.message}` });
        },
      );
      return () => { ++modelsRequest.current; };
    },
    [ready, accountId],
  );

  // A started Session takes only its provider's models: the recorded one, else its first Turn's.
  const selectedProvider = models.loaded ? models.models.find(({ key }) => key === model)?.provider : undefined;
  const sessionProvider = activeProvider ?? (showWelcome ? undefined : selectedProvider);
  const offeredModels: ModelList =
    !models.loaded || sessionProvider === undefined
      ? models
      : { ...models, models: models.models.filter(({ provider }) => provider === sessionProvider) };
  // Use the provider's valid selection in this render, before the effect remembers it.
  const offeredModel = modelInList(offeredModels, model);
  const properties = useMemo(() => ({ model: offeredModel, effort, sandbox: true }), [offeredModel, effort]);
  useEffect(() => {
    if (offeredModel !== model) {
      modelChosen.current = false;
      setModel(offeredModel);
    }
  }, [offeredModel, model]);

  return {
    catalog: models,
    picker: {
      models: offeredModels,
      model: offeredModel,
      effort,
      onModelChange(picked: string) {
        modelChosen.current = true;
        setModel(picked);
        rememberChoice({ model: picked, account: accountId });
      },
      onEffortChange(picked: string) {
        setEffort(picked);
        rememberChoice({ effort: picked });
      },
    },
    properties,
    choiceError,
  };
}
