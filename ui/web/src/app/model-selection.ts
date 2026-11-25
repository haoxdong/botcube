"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAgentModels, type AgentModel } from "./agent-models";

/** The account's models, or why they could not load (no reason while they load). */
export type ModelList = { loaded: true; accountId: string | undefined; models: AgentModel[] } | { loaded: false; error: string | null };

/** The model and effort the user last picked in this browser; the model belongs to the account it was picked on. */
interface PickerChoice {
  model?: string;
  account?: string | undefined;
  effort?: string;
  shown?: { account: string | undefined; label: string };
}

const PICKER_CHOICE_KEY = "botcube.picker-choice";

function storedChoice(): PickerChoice {
  return JSON.parse(localStorage.getItem(PICKER_CHOICE_KEY) ?? "{}") as PickerChoice;
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

/** The effort levels the BotCube harness takes (its `EFFORT_LEVELS`), Medium by default. */
export const EFFORT_LEVELS = [
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
  { key: "max", label: "Max" },
];

function offeredEffort(effort: string | undefined): string {
  return EFFORT_LEVELS.find(({ key }) => key === effort)?.key ?? "medium";
}

function modelInList(models: ModelList, selected: string | undefined): string | undefined {
  if (!models.loaded || models.models.some(({ key }) => key === selected)) return selected;
  return models.models[0]?.key;
}

/** The account's offered choice, and its browser persistence. */
export function useModelSelection({
  ready,
  accountId,
  chatServiceUrl,
}: {
  ready: boolean;
  accountId: string | undefined;
  chatServiceUrl: string;
}) {
  const [modelList, setModels] = useState<ModelList>({ loaded: false, error: null });
  const [model, setModel] = useState<string | undefined>(undefined);
  const modelChosen = useRef(false);
  /** The choice stored in this browser, whose model an account starts on only if it was picked there. */
  const [{ stored, readError }] = useState(readChoice);
  const storedModel = stored.account === accountId ? stored.model : undefined;
  const shown = useRef(stored.shown);
  const shownLabel = shown.current && (!ready || shown.current.account === accountId) ? shown.current.label : undefined;
  const [choiceError, setChoiceError] = useState(readError);
  /** Keep the choice in this browser; one that blocks storage says so, and the choice lasts until the page reloads. */
  const rememberChoice = (change: PickerChoice) => {
    try {
      localStorage.setItem(PICKER_CHOICE_KEY, JSON.stringify({ ...storedChoice(), ...change }));
      setChoiceError(null);
    } catch (error) {
      setChoiceError(choiceNotKept(error));
    }
  };
  const [effort, setEffort] = useState(() => offeredEffort(stored.effort));
  const models: ModelList = modelList.loaded && modelList.accountId !== accountId ? { loaded: false, error: null } : modelList;
  const modelsRequest = useRef(0);
  useEffect(
    () => {
      if (!ready) return;
      const request = ++modelsRequest.current;
      setModels({ loaded: false, error: null });
      fetchAgentModels({ chatServiceUrl }).then(
        (loaded) => {
          if (request !== modelsRequest.current) return;
          setModels({ loaded: true, accountId, models: loaded });
          // A model picked in this page stays the choice on the account the page moves to, after a reload too.
          if (modelChosen.current) rememberChoice({ account: accountId });
          else setModel(storedModel);
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

  const offeredModel = modelInList(models, model ?? (models.loaded ? undefined : storedModel));
  const offeredLabel = models.loaded ? models.models.find(({ key }) => key === offeredModel)?.label : undefined;
  useEffect(() => {
    if (offeredLabel === undefined || (shown.current?.account === accountId && shown.current?.label === offeredLabel)) return;
    shown.current = { account: accountId, label: offeredLabel };
    rememberChoice({ shown: shown.current });
  }, [offeredLabel, accountId]);
  const confirmedModel = models.loaded ? offeredModel : undefined;
  const properties = useMemo(() => ({ model: confirmedModel, effort, sandbox: true }), [confirmedModel, effort]);
  useEffect(() => {
    if (offeredModel !== model) {
      modelChosen.current = false;
      setModel(offeredModel);
    }
  }, [offeredModel, model]);

  return {
    catalog: models,
    picker: {
      models,
      model: offeredModel,
      effort,
      loadingLabel: shownLabel,
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
