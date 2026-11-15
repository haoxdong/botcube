"use client";

import { Swap, Presence, presenceMotion, Layout } from "./collapse";

import { animateMini, m as motionElement } from "framer-motion";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motionTokens } from "./motion-tokens";
import { Popover } from "@base-ui/react/popover";
import { EFFORT_LEVELS, type ModelList } from "./model-selection";
import { webUiPlugin } from "@cartridge-ui";
import { pickerModels } from "./picker-models";

export function ModelEffortPicker({
  models,
  model,
  effort,
  loadingLabel,
  onModelChange,
  onEffortChange,
}: {
  models: ModelList;
  model: string | undefined;
  effort: string;
  loadingLabel: string | undefined;
  onModelChange: (v: string) => void;
  onEffortChange: (v: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"main" | "effort">("main");

  const catalog = models.loaded ? models.models : [];
  const options = pickerModels(catalog, webUiPlugin.config.pickerModelFamilies);
  const modelLabel = models.loaded ? catalog.find((item) => item.key === model)?.label : (models.error ?? loadingLabel ?? "Loading models…");
  const effortLabel = EFFORT_LEVELS.find((item) => item.key === effort)?.label ?? effort;

  useWidthAnimation(trigger, `${modelLabel} ${effortLabel}`);

  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) setPanel("main"); }}>
    <div className="mep">
      <Popover.Trigger ref={trigger}
        className="mep-pill"
        type="button"
        aria-expanded={open}
        aria-label={`Model ${modelLabel}, reasoning ${effortLabel}`}
      >
        <span className="mep-pill-model">
          <Swap as="span" state={modelLabel ?? "loading"}>{modelLabel === "GPT-6-Astra" ? <>
            <motionElement.span {...presenceMotion} key="0" className="mep-pill-model-desktop">{modelLabel}</motionElement.span>
            <motionElement.span {...presenceMotion} key="1" className="mep-pill-model-phone">6 Astra</motionElement.span>
          </> : modelLabel}</Swap>
        </span>
        <span className="mep-pill-effort">{effortLabel}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="standard-popup-positioner" side="top" align="end" sideOffset={8} anchor={() => trigger.current?.closest(".copilotKitInput") ?? trigger.current}>
          <Popover.Popup finalFocus={trigger} render={<Layout layoutDependency={panel} />} className="mep-dropdown standard-popup">
        <Swap state={panel}>{panel === "main" ? (
          <>
            {options.map((m) => (
              <PickerOption key={m.key} selected={m.key === model} onSelect={() => onModelChange(m.key)}>
                <div>
                  <div className="mep-option-name">{m.label}</div>
                  <Presence>{m.description && <motionElement.div {...presenceMotion} className="mep-option-desc">{m.description}</motionElement.div>}</Presence>
                </div>
              </PickerOption>
            ))}
            <motionElement.div {...presenceMotion} key="0" className="mep-separator" />
            <motionElement.button {...presenceMotion} key="1" className="mep-option" onClick={() => setPanel("effort")}>
              <span className="mep-option-name">Effort</span>
              <span className="mep-option-right">
                {effortLabel}
                <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
                  <path d="M1 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </motionElement.button>
          </>
        ) : (
          <>
            <motionElement.button {...presenceMotion} key="2" className="mep-option mep-back" onClick={() => setPanel("main")}>
              <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
                <path d="M6 1L1 6l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="mep-option-name">Effort</span>
            </motionElement.button>
            <motionElement.div {...presenceMotion} key="3" className="mep-separator" />
            {EFFORT_LEVELS.map((e) => (
              <PickerOption key={e.key} selected={e.key === effort} onSelect={() => { onEffortChange(e.key); setPanel("main"); }}>
                <span className="mep-option-name">{e.label}</span>
              </PickerOption>
            ))}
          </>
        )}</Swap>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </div>
    </Popover.Root>
  );
}

function PickerOption({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: ReactNode }) {
  return <button className="mep-option" onClick={onSelect}>
    {children}
    <Presence>{selected && (
      <motionElement.svg {...presenceMotion} layout={false} className="mep-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </motionElement.svg>
    )}</Presence>
  </button>;
}

function useWidthAnimation(ref: { current: HTMLButtonElement | null }, label: string) {
  const previous = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const from = previous.current;
    element.style.width = "auto";
    const to = element.getBoundingClientRect().width;
    previous.current = to;
    if (from === null || from === to) return;
    const animation = animateMini(element, { width: [from, to] }, { ...motionTokens().move, onComplete: () => { element.style.width = "auto"; } });
    return () => {
      if (animation.state === "running") previous.current = element.getBoundingClientRect().width;
      animation.stop();
    };
  }, [ref, label]);
}
