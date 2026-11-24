import { describe, expect, it } from 'vitest';

import { measure, moves, overBudget, type Seen } from './motion-budget';

const at = (start: number, ms: number, target = 'div.panel', property = 'opacity'): Seen => ({ target, property, start, end: start + ms });

describe('measure', () => {
  it('groups starts within two frames into one stage, and times the stages from the first start', () => {
    const measured = measure([at(1000, 150), at(1030, 150, 'div.scrim')], 0);
    expect(measured.stages).toHaveLength(1);
    expect(measured).toMatchObject({ ms: 180 });
  });

  it('opens a new stage for a start more than two frames after the stage last started', () => {
    const measured = measure([at(1000, 200), at(1020, 200), at(1300, 200, 'ul.list')], 0);
    expect(measured.stages.map((stage) => stage.length)).toEqual([2, 1]);
    expect(measured).toMatchObject({ ms: 500 });
  });

  it('counts a stagger as more than one stage: each stage is timed from its first start', () => {
    expect(measure([at(0, 150), at(30, 150), at(60, 150), at(90, 150)], 0).stages).toHaveLength(2);
  });

  it('measures nothing for an instant change', () => {
    expect(measure([], 0)).toEqual({ stages: [], ms: 0, shift: 0 });
  });
});

describe('overBudget', () => {
  it('holds one stage within 300 ms and no layout shift by default', () => {
    expect(overBudget(measure([at(0, 300)], 0))).toEqual([]);
  });

  it('names each stage of an action that starts more than one', () => {
    const [broken] = overBudget(measure([at(0, 200, 'div.skeleton'), at(400, 200, 'ul.list')], 0));
    expect(broken).toBe('2 motion stages, budget 1: div.skeleton opacity @0ms | ul.list opacity @400ms');
  });

  it('fails a motion that runs past its budget, and a layout shift', () => {
    expect(overBudget(measure([at(0, 400)], 0.02))).toEqual(['motion ran 400 ms, budget 300', 'layout shifted (score 0.0200)']);
  });

  it('takes a loosened budget only with a reason', () => {
    const slide = measure([at(0, 400, 'div.pane', 'flex-grow')], 0.05);
    expect(overBudget(slide, { ms: 450, shift: true })).toEqual(['parameters.motion loosens the default budget without a `why`']);
    expect(overBudget(slide, { ms: 450, shift: true, why: 'The pane slides in and the chat takes its new width once.' })).toEqual([]);
  });
});

describe('moves', () => {
  it('counts what moves or fades, not the repaint of a touched control', () => {
    expect(['opacity', 'transform', 'flex-grow', 'height', 'opacity+transform'].map((property) => moves({ property }))).toEqual([true, true, true, true, true]);
    expect(['box-shadow', 'background-color', 'border-top-color', 'outline-width', 'color', 'visibility'].map((property) => moves({ property }))).toEqual([false, false, false, false, false, false]);
  });
});
