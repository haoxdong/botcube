"use client";

import { RotateCcw } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../components/ui/select";
import { Slider } from "../components/ui/slider";
import { EFFORT_LEVELS, type ModelList } from "./model-selection";
import { zoomOf } from "@/lib/utils";
import { composerEdges } from "./composer-edges";

const RESERVED_LABEL = "Loading models… Medium";
const DEFAULT_EFFORT = "medium";

export function ModelSelector({ models, model, effort, loadingLabel, onModelChange, onEffortChange }: {
  models: ModelList;
  model: string | undefined;
  effort: string;
  loadingLabel: string | undefined;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const effortName = useId();
  const [open, setOpen] = useState(false);
  const catalog = models.loaded ? models.models : [];
  const modelLabel = models.loaded ? catalog.find((item) => item.key === model)?.label : (models.error ?? loadingLabel ?? "Loading models…");
  const effortLabel = EFFORT_LEVELS.find((item) => item.key === effort)?.label ?? effort;
  const step = Math.max(0, EFFORT_LEVELS.findIndex((item) => item.key === effort));
  const last = EFFORT_LEVELS.length - 1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={trigger}
        aria-label={`Model ${modelLabel}, reasoning ${effortLabel}`}
        className="grid h-11 max-w-full min-w-0 cursor-pointer items-center rounded-md px-1.5 text-small whitespace-nowrap text-(--color-text) outline-none min-[641px]:h-9"
      >
        <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden">{RESERVED_LABEL}</span>
        <span className="col-start-1 row-start-1 flex min-w-0 justify-self-end">
          <span className="min-w-0 truncate">{modelLabel}</span>&nbsp;<span className="shrink-0 text-(--color-text-muted)">{effortLabel}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={() => composerEdges(trigger.current).above + 8 * zoomOf(trigger.current)}
        alignOffset={() => -composerEdges(trigger.current).right}
        aria-label="Model and effort"
        className="model-card"
      >
        <div className="relative flex flex-col items-center">
          <div role="status" className="flex h-8 items-center text-lg font-semibold"><span id={effortName} className="sr-only">Effort</span>{effortLabel}</div>
          <Button variant="ghost" size="icon" aria-label="Reset effort" className="absolute top-0 right-0 text-(--color-text-muted) focus-visible:bg-(--color-fill) focus-visible:text-(--color-text)" onClick={() => onEffortChange(DEFAULT_EFFORT)}><RotateCcw /></Button>
          <Select value={model ?? null} onValueChange={(selected: string | null) => { if (selected !== null) onModelChange(selected); }}>
            <SelectTrigger
              aria-label={`Model ${modelLabel}`}
              size="sm"
              className="h-6 gap-0.5 border-0 bg-transparent px-1 font-normal text-(--color-text-muted) hover:text-(--color-text) focus-visible:text-(--color-text) dark:bg-transparent dark:hover:bg-transparent"
            >
              {modelLabel}
            </SelectTrigger>
            <SelectContent className="w-auto">
              {catalog.map((choice) => <SelectItem key={choice.key} value={choice.key} label={choice.label}>
                <span className="flex flex-col">
                  <span>{choice.label}</span>
                  <span className="max-w-64 text-xs whitespace-normal text-(--color-text-muted) empty:hidden">{choice.description}</span>
                </span>
              </SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="relative mt-1">
          <Slider
            min={0}
            max={last}
            step={1}
            value={[step]}
            aria-labelledby={effortName}
            onValueChange={(value) => { const index = Array.isArray(value) ? value[0] : value; const level = index === undefined ? undefined : EFFORT_LEVELS[index]; if (level) onEffortChange(level.key); }}
            className="[&_[data-slot=slider-range]]:bg-(--color-text) [&_[data-slot=slider-thumb]]:z-(--layer-raised) [&_[data-slot=slider-thumb]]:size-8 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:shadow-(--shadow-thumb) [&_[data-slot=slider-thumb]]:hover:ring-0 [&_[data-slot=slider-thumb]]:active:ring-0 [&_[data-slot=slider-track]]:data-horizontal:h-7"
          />
          <div aria-hidden className="pointer-events-none absolute inset-x-4 top-1/2">
            {EFFORT_LEVELS.map((level, index) => <span
              key={level.key}
              className={`absolute size-1.5 -translate-1/2 rounded-full ${index < step ? "bg-(--color-white)/40" : "bg-(--color-text)/30"}`}
              style={{ left: `${(index / last) * 100}%` }}
            />)}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
