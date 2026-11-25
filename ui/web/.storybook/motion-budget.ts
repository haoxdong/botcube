import { animationsSettled } from './animations-settled';

/**
 * What one user action may start: at most `stages` motion stages, together running at most `ms`, and no
 * layout shift unless `shift`. A story loosens the default through `parameters.motion`, and says `why`.
 */
export type MotionBudget = { stages?: number; ms?: number; shift?: boolean; why?: string };
const DEFAULT = { stages: 1, ms: 300, shift: false };

/** Starts this close to the stage's first start join it: two frames, as headless CI drops one now and then. */
const STAGE_WINDOW_MS = 34;
/** A layout shift score above this counts. */
const SHIFT = 0.001;

/**
 * Properties that repaint without moving or fading anything: a control's hover, focus and press feedback. They are not
 * motion stages.
 */
const PAINT_ONLY = /^(color|background-color|border(-(top|right|bottom|left))?-color|box-shadow|outline(-\w+)?|text-decoration-color|caret-color|fill|stroke|visibility|order)$/;
export const moves = ({ property }: Pick<Seen, 'property'>) => property.split('+').some((part) => !PAINT_ONLY.test(part));

/** One animation the action started, on the document timeline. */
export type Seen = { target: string; property: string; start: number; end: number };
export type Measured = { stages: Seen[][]; ms: number; shift: number };

/** Groups what an action started into stages by start time, and measures how long they ran together. */
export function measure(seen: readonly Seen[], shift: number): Measured {
  const ordered = [...seen].sort((a, b) => a.start - b.start);
  const stages: Seen[][] = [];
  for (const animation of ordered) {
    const stage = stages.at(-1);
    const opened = stage?.[0];
    if (stage && opened && animation.start - opened.start <= STAGE_WINDOW_MS) stage.push(animation);
    else stages.push([animation]);
  }
  const first = ordered[0]?.start ?? 0;
  const ms = ordered.length === 0 ? 0 : Math.max(...ordered.map((animation) => animation.end)) - first;
  return { stages, ms: Math.round(ms), shift };
}

/** Why `measured` breaks `budget`, one line each; empty when it holds. */
export function overBudget(measured: Measured, budget: MotionBudget = {}): string[] {
  const loosened = (Object.keys(DEFAULT) as (keyof typeof DEFAULT)[]).some((key) => budget[key] !== undefined && budget[key] !== DEFAULT[key]);
  if (loosened && !budget.why) return ['parameters.motion loosens the default budget without a `why`'];
  const { stages, ms, shift } = { ...DEFAULT, ...budget };
  const { ms: ran } = measured;
  const named = (stage: Seen[]) => stage.map(({ target, property, start }) => `${target} ${property} @${Math.round(start - (measured.stages[0]?.[0]?.start ?? 0))}ms`).join(', ');
  return [
    ...(measured.stages.length > stages ? [`${measured.stages.length} motion stages, budget ${stages}: ${measured.stages.map(named).join(' | ')}`] : []),
    ...(ran > ms ? [`motion ran ${ran} ms, budget ${ms}`] : []),
    ...(!shift && measured.shift > SHIFT ? [`layout shifted (score ${measured.shift.toFixed(4)})`] : []),
  ];
}

function name(animation: Animation) {
  const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
  if (!(target instanceof Element)) return '?';
  const classes = [...target.classList].slice(0, 2).map((value) => `.${value}`).join('');
  const label = target.closest('[aria-label]')?.getAttribute('aria-label') ?? target.textContent.trim().slice(0, 24);
  return `${target.tagName.toLowerCase()}${classes}${label ? `[${label}]` : ''}`;
}

function property(animation: Animation) {
  if ('transitionProperty' in animation) return String(animation.transitionProperty);
  if ('animationName' in animation) return String(animation.animationName);
  const frames = animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
  return [...new Set(frames.flatMap((frame) => Object.keys(frame).filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))].join('+');
}

/** A finite animation on the document timeline, with where it started and ends there. */
function seen(document: Document, animation: Animation): Seen | null {
  if (animation.timeline !== document.timeline || animation.startTime === null || animation.effect === null) return null;
  const timing = animation.effect.getComputedTiming();
  if (timing.iterations === Infinity || typeof timing.endTime !== 'number') return null;
  const start = Number(animation.startTime) + Number(timing.delay ?? 0);
  return { target: name(animation), property: property(animation), start, end: Number(animation.startTime) + timing.endTime };
}

/**
 * Runs `act`, a story's one user action, and fails when it breaks the story's motion budget (`parameters.motion`).
 * Animations are sampled every frame, since a finished one leaves `document.getAnimations()`; those running before
 * the action are not its own. Layout shift comes from a `layout-shift` PerformanceObserver.
 */
export async function expectMotionBudget(
  { canvasElement, parameters }: { canvasElement: HTMLElement; parameters: { motion?: MotionBudget; [key: string]: unknown } },
  act: () => Promise<unknown>,
): Promise<Measured> {
  const document = canvasElement.ownerDocument;
  await animationsSettled(document);
  const before = new Set(document.getAnimations());
  const started = new Map<Animation, Seen>();
  let shift = 0;
  const shifted = new Set<string>();
  type Shift = PerformanceEntry & { value: number; sources?: { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] };
  const rect = ({ x, y, width, height }: DOMRectReadOnly) => [x, y, width, height].map(Math.round).join(',');
  const add = (entries: PerformanceEntryList) => {
    for (const entry of entries as Shift[]) {
      shift += entry.value;
      for (const { node, previousRect, currentRect } of entry.sources ?? []) if (node instanceof Element) shifted.add(`${node.tagName.toLowerCase()}${[...node.classList].slice(0, 2).map((value) => `.${value}`).join('')} ${rect(previousRect)} → ${rect(currentRect)}`);
    }
  };
  const observer = new PerformanceObserver((list) => add(list.getEntries()));
  observer.observe({ type: 'layout-shift' });
  const sample = () => {
    for (const animation of document.getAnimations()) {
      // One already finished when first sampled never drew a frame: Fluent's presence parts set their starting styles that way.
      if (before.has(animation) || (!started.has(animation) && animation.playState === 'finished')) continue;
      const found = seen(document, animation);
      if (found && moves(found)) started.set(animation, found);
    }
  };
  let sampling = true;
  const tick = () => {
    sample();
    if (sampling) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    await act();
    await animationsSettled(document);
    sample();
  } finally {
    sampling = false;
    add(observer.takeRecords());
    observer.disconnect();
  }
  const measured = measure([...started.values()], shift);
  const broken = overBudget(measured, parameters.motion);
  if (broken.length > 0) throw new Error(`Motion budget: ${broken.join('; ')}${shifted.size > 0 ? ` (shifted: ${[...shifted].join(', ')})` : ''}`);
  return measured;
}
