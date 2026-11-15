"use client";

import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { AnimatePresence, domMax, LazyMotion, m as motionElement, useIsPresent, type HTMLMotionProps, type Transition } from "framer-motion";
import { useId, useRef, useState } from "react";
import { webUiPlugin } from "@cartridge-ui";

import { presenceMotion, useInstant } from "./collapse";
import { EFFORT_LEVELS, type ModelList } from "./model-selection";
import { pickerModels } from "./picker-models";

const pickerSpring = { type: "spring", visualDuration: 0.3, bounce: 0 } satisfies Transition;

export function ModelSelector({ models, model, effort, loadingLabel, onModelChange, onEffortChange }: {
  models: ModelList;
  model: string | undefined;
  effort: string;
  loadingLabel: string | undefined;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}) {
  const instant = useInstant();
  const transition = instant ? { duration: 0 } : pickerSpring;
  const pickerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const catalog = models.loaded ? models.models : [];
  const options = pickerModels(catalog, webUiPlugin.config.pickerModelFamilies);
  const modelLabel = models.loaded ? catalog.find((item) => item.key === model)?.label : (models.error ?? loadingLabel ?? "Loading models…");
  const effortLabel = EFFORT_LEVELS.find((item) => item.key === effort)?.label ?? effort;

  return (
    <LazyMotion features={domMax} strict><Popover.Root<"main" | "effort"> open={open} onOpenChange={(next, details) => setOpen(next && !(open && details.trigger === trigger.current))}>
      {({ payload }) => <>
        <div className="mep">
          <Popover.Trigger ref={trigger} payload="main" className="mep-pill" aria-expanded={open} aria-label={`Model ${modelLabel}, reasoning ${effortLabel}`}>
            <motionElement.span layout transition={transition} className="mep-pill-background" data-model={modelLabel} data-phone-model={modelLabel === "GPT-6-Astra" ? "6 Astra" : modelLabel} data-effort={effortLabel} aria-hidden />
            <motionElement.span layout="position" transition={{ layout: transition }} className="mep-pill-model">
              <span className={modelLabel === "GPT-6-Astra" ? "mep-pill-model-desktop" : undefined}>{modelLabel}</span>
              <span className="mep-pill-model-phone">{modelLabel === "GPT-6-Astra" ? "6 Astra" : ""}</span>
            </motionElement.span>
            <motionElement.span layout="position" transition={{ layout: transition }} className="mep-pill-effort">{effortLabel}</motionElement.span>
            <motionElement.span layout="position" transition={{ layout: transition }} className="mep-pill-chevron" aria-hidden><svg width="10" height="6" viewBox="0 0 10 6" fill="none">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg></motionElement.span>
          </Popover.Trigger>
        </div>
        <Popover.Portal keepMounted>
          <Popover.Positioner className="mep-positioner standard-popup-positioner" side="top" align="end" sideOffset={8} anchor={() => trigger.current?.closest(".copilotKitInput") ?? trigger.current}>
            <Popover.Popup ref={popup} initialFocus={popup} render={<motionElement.div layout layoutDependency={`${open && payload === "effort" ? "effort" : "main"}:${options.length}`} initial={instant ? false : { opacity: 0 }} animate={{ opacity: open ? 1 : 0 }} transition={transition} />} finalFocus={trigger} aria-label="Model and effort" className="mep-dropdown mep-spring standard-popup">
              <AnimatePresence mode="popLayout" initial={false}>
                {payload === "effort" ? <PickerPage key="effort" {...presenceMotion} transition={transition}>
                  <Popover.Trigger id={`${pickerId}-back`} payload="main" className="mep-option mep-back" aria-label="Back to models">
                    <svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden><path d="M6 1L1 6l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <span className="mep-option-name">Effort</span>
                  </Popover.Trigger>
                  <div className="mep-separator" />
                  <RadioGroup aria-label="Effort" value={effort} onValueChange={(selected: string) => onEffortChange(selected)}>
                    {EFFORT_LEVELS.map((choice) => <Popover.Trigger key={choice.key} id={`${pickerId}-${choice.key}`} payload="main" render={<Radio.Root value={choice.key} nativeButton render={<button type="button" />} />} className="mep-option">
                      <span className="mep-option-name">{choice.label}</span>
                      <ChoiceIndicator />
                    </Popover.Trigger>)}
                  </RadioGroup>
                </PickerPage> : <PickerPage key="main" {...presenceMotion} transition={transition}>
                  <RadioGroup aria-label="Model" value={model ?? null} onValueChange={(selected: string | null) => { if (selected !== null) onModelChange(selected); }}>
                    {options.map((choice) => <Radio.Root key={choice.key} value={choice.key} nativeButton render={<button type="button" />} className="mep-option">
                      <div>
                        <div className="mep-option-name">{choice.label}</div>
                        <AnimatePresence initial={false}>{choice.description && <motionElement.div {...presenceMotion} transition={transition} className="mep-option-desc">{choice.description}</motionElement.div>}</AnimatePresence>
                      </div>
                      <ChoiceIndicator />
                    </Radio.Root>)}
                  </RadioGroup>
                  <div className="mep-separator" />
                  <Popover.Trigger id={`${pickerId}-effort`} payload="effort" className="mep-option" aria-label={`Effort ${effortLabel}`}>
                    <span className="mep-option-name">Effort</span>
                    <span className="mep-option-right">{effortLabel}<svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden><path d="M1 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
                  </Popover.Trigger>
                </PickerPage>}
              </AnimatePresence>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </>}
    </Popover.Root></LazyMotion>
  );
}

function ChoiceIndicator() {
  return <Radio.Indicator className="mep-check">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  </Radio.Indicator>;
}

function PickerPage(props: HTMLMotionProps<"div">) {
  const present = useIsPresent();
  return <motionElement.div {...props} inert={!present} aria-hidden={!present} />;
}
