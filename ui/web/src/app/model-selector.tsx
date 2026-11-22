"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { AnimatePresence, domMax, LazyMotion, MotionConfig, m as motionElement, useIsPresent, type HTMLMotionProps, type Transition } from "motion/react";
import { cloneElement, useId, useRef, useState, type ComponentProps } from "react";
import { webUiPlugin } from "@bot-ui";

import { presenceMotion, useInstant } from "./collapse";
import { EFFORT_LEVELS, type ModelList } from "./model-selection";
import { pickerModels } from "./picker-models";
import { motionTokens } from "./motion-tokens";

export function ModelSelector({ models, model, effort, loadingLabel, onModelChange, onEffortChange }: {
  models: ModelList;
  model: string | undefined;
  effort: string;
  loadingLabel: string | undefined;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}) {
  const instant = useInstant();
  const move = motionTokens().move;
  const transition = instant ? { duration: 0 } : { ...move, visualDuration: move.visualDuration * 2 } satisfies Transition;
  const pickerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const actions = useRef<PopoverPrimitive.Root.Actions>(null);
  const [open, setOpen] = useState(false);
  const catalog = models.loaded ? models.models : [];
  const options = pickerModels(catalog, webUiPlugin.config.pickerModelFamilies);
  const modelLabel = models.loaded ? catalog.find((item) => item.key === model)?.label : (models.error ?? loadingLabel ?? "Loading models…");
  const effortLabel = EFFORT_LEVELS.find((item) => item.key === effort)?.label ?? effort;

  return (
    <LazyMotion features={domMax} strict><MotionConfig transition={transition}><PopoverPrimitive.Root<"main" | "effort"> open={open} actionsRef={actions} onOpenChange={(next, details) => { const nextOpen = next && !(open && details.trigger === trigger.current); if (!nextOpen) details.preventUnmountOnClose(); setOpen(nextOpen); }}>
      {({ payload }) => <>
        <div className="mep">
          <PopoverPrimitive.Trigger ref={trigger} payload="main" className="mep-pill" aria-expanded={open} aria-label={`Model ${modelLabel}, reasoning ${effortLabel}`}>
            <span className="mep-pill-background" data-model={modelLabel} data-phone-model={modelLabel === "GPT-6-Astra" ? "6 Astra" : modelLabel} data-effort={effortLabel} aria-hidden />
            <span className="mep-pill-model">
              <span className={modelLabel === "GPT-6-Astra" ? "mep-pill-model-desktop" : undefined}>{modelLabel}</span>
              <span className="mep-pill-model-phone">{modelLabel === "GPT-6-Astra" ? "6 Astra" : ""}</span>
            </span>
            <span className="mep-pill-effort">{effortLabel}</span>
            <span className="mep-pill-chevron" aria-hidden><svg width="10" height="6" viewBox="0 0 10 6" fill="none">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg></span>
          </PopoverPrimitive.Trigger>
        </div>
        <PopoverPrimitive.Portal><PopoverPrimitive.Positioner className="standard-popup-positioner" style={{ display: "grid", gridTemplateRows: "0px", alignItems: "end" }} side="top" align="end" sideOffset={8} anchor={() => trigger.current?.closest(".chat-composer") ?? trigger.current} render={(positionerProps) => cloneElement(<motionElement.div layoutRoot layout={!instant} data-framer-portal-id={pickerId} transformTemplate={() => positionerProps.style?.transform ?? "none"} />, positionerProps, <PopoverPrimitive.Popup ref={popup} initialFocus={popup} finalFocus={trigger} render={<motionElement.div layoutAnchor={{ x: 1, y: 1 }} layout={!instant && positionerProps.style?.opacity !== 0} style={{ originX: 1, originY: 1 }} initial={instant ? false : { opacity: 0 }} animate={{ opacity: open ? 1 : 0 }} transition={transition} onAnimationComplete={() => { if (!open) actions.current?.unmount(); }} />} aria-label="Model and effort" className="mep-dropdown mep-spring standard-popup">
              <AnimatePresence mode="popLayout" initial={false}>
                {payload === "effort" ? <PickerPage key="effort" {...presenceMotion} layout transition={transition}>
                  <PopoverPrimitive.Trigger id={`${pickerId}-back`} payload="main" className="mep-option mep-back" aria-label="Back to models">
                    <svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden><path d="M6 1L1 6l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <span className="mep-option-name">Effort</span>
                  </PopoverPrimitive.Trigger>
                  <div className="mep-separator" />
                  <RadioGroup className="mep-choices" aria-label="Effort" value={effort} onValueChange={(selected: string) => onEffortChange(selected)}>
                    {EFFORT_LEVELS.map((choice) => <PopoverPrimitive.Trigger key={choice.key} id={`${pickerId}-${choice.key}`} payload="main" render={<PickerChoice value={choice.key} />} className="mep-option">
                      <span className="mep-option-name">{choice.label}</span>
                    </PopoverPrimitive.Trigger>)}
                  </RadioGroup>
                </PickerPage> : <PickerPage key="main" {...presenceMotion} layout transition={transition}>
                  <RadioGroup className="mep-choices" aria-label="Model" value={model ?? null} onValueChange={(selected: string | null) => { if (selected !== null) onModelChange(selected); }}>
                    {options.map((choice) => <PickerChoice key={choice.key} value={choice.key} className="mep-option">
                      <div>
                        <div className="mep-option-name">{choice.label}</div>
                        <AnimatePresence initial={false}>{choice.description && <motionElement.div {...presenceMotion} transition={transition} className="mep-option-desc">{choice.description}</motionElement.div>}</AnimatePresence>
                      </div>
                    </PickerChoice>)}
                  </RadioGroup>
                  <div className="mep-separator" />
                  <PopoverPrimitive.Trigger id={`${pickerId}-effort`} payload="effort" className="mep-option" aria-label={`Effort ${effortLabel}`}>
                    <span className="mep-option-name">Effort</span>
                    <span className="mep-option-right">{effortLabel}<svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden><path d="M1 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
                  </PopoverPrimitive.Trigger>
                </PickerPage>}
              </AnimatePresence>
        </PopoverPrimitive.Popup>)} /></PopoverPrimitive.Portal>
      </>}
    </PopoverPrimitive.Root></MotionConfig></LazyMotion>
  );
}

function PickerChoice({ children, ...props }: ComponentProps<typeof RadioGroupItem>) {
  return <RadioGroupItem {...props} className="mep-option" nativeButton render={(buttonProps, state) => <button {...buttonProps} type="button">
    {children}
    <AnimatePresence initial={false}>{state.checked && <motionElement.svg {...presenceMotion} className="mep-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></motionElement.svg>}</AnimatePresence>
  </button>} />;
}

function PickerPage(props: HTMLMotionProps<"div">) {
  const present = useIsPresent();
  return <motionElement.div {...props} inert={!present} aria-hidden={!present} />;
}
