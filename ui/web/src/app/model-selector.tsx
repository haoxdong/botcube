"use client";

import { Menu } from "@base-ui/react/menu";
import { m as motionElement } from "framer-motion";
import { useRef, type ReactNode } from "react";
import { webUiPlugin } from "@cartridge-ui";

import { Presence, Swap, presenceMotion } from "./collapse";
import { EFFORT_LEVELS, type ModelList } from "./model-selection";
import { pickerModels } from "./picker-models";

type Choice = { key: string; label: string; description?: string };

export function ModelSelector({ models, model, effort, loadingLabel, onModelChange, onEffortChange }: {
  models: ModelList;
  model: string | undefined;
  effort: string;
  loadingLabel: string | undefined;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}) {
  const catalog = models.loaded ? models.models : [];
  const options = pickerModels(catalog, webUiPlugin.config.pickerModelFamilies);
  const modelLabel = models.loaded ? catalog.find((item) => item.key === model)?.label : (models.error ?? loadingLabel ?? "Loading models…");
  const effortLabel = EFFORT_LEVELS.find((item) => item.key === effort)?.label ?? effort;

  return (
    <div className="mep">
      <SelectionMenu label={`Model ${modelLabel}, reasoning ${effortLabel}`} value={model} choices={options} onChange={onModelChange}>
        <span className="mep-pill-model" data-reserve-label="Loading models…">
          <Swap as="span" state={modelLabel ?? "loading"}>{modelLabel === "GPT-6-Astra" ? <>
            <span className="mep-pill-model-desktop">{modelLabel}</span>
            <span className="mep-pill-model-phone">6 Astra</span>
          </> : modelLabel}</Swap>
        </span>
      </SelectionMenu>
      <SelectionMenu label={`Reasoning ${effortLabel}`} value={effort} choices={EFFORT_LEVELS} onChange={onEffortChange}>
        <span className="mep-pill-effort" data-reserve-label="Medium"><Swap as="span" state={effortLabel}>{effortLabel}</Swap></span>
      </SelectionMenu>
    </div>
  );
}

function SelectionMenu({ label, value, choices, onChange, children }: {
  label: string;
  value: string | undefined;
  choices: Choice[];
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger ref={trigger} className="mep-pill" aria-label={label}>
        {children}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden>
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="standard-popup-positioner" side="top" align="end" sideOffset={8} anchor={() => trigger.current?.closest(".copilotKitInput") ?? trigger.current}>
          <Menu.Popup finalFocus={trigger} className="mep-dropdown standard-popup">
            <Menu.RadioGroup value={value ?? null} onValueChange={(selected: string) => onChange(selected)}>
              {choices.map((choice) => (
                <Menu.RadioItem key={choice.key} value={choice.key} label={choice.label} className="mep-option">
                  <div>
                    <div className="mep-option-name">{choice.label}</div>
                    <Presence>{choice.description && <motionElement.div {...presenceMotion} className="mep-option-desc">{choice.description}</motionElement.div>}</Presence>
                  </div>
                  <Menu.RadioItemIndicator className="mep-check standard-popup">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
