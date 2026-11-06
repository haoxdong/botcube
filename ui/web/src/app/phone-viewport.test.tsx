import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePhoneViewport } from './phone-viewport';

const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });

beforeEach(() => {
  Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('visualViewport', viewport);
});
afterEach(() => vi.unstubAllGlobals());

it('insets the flow shell above the keyboard and follows Safari pan and dismissal', () => {
  const { result } = renderHook(usePhoneViewport);
  expect(result.current.inset).toBe(0);
  act(() => {
    viewport.height = 500;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(result.current.inset).toBe(344);
  act(() => {
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(result.current.inset).toBe(224);
  act(() => {
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(result.current.inset).toBe(0);
});

it('leaves pinch zoom and a layout viewport already resized by the keyboard to the browser', () => {
  const { result } = renderHook(usePhoneViewport);
  act(() => {
    viewport.height = 422;
    viewport.scale = 2;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(result.current.inset).toBe(0);
  act(() => {
    viewport.height = 500;
    viewport.scale = 1;
    vi.stubGlobal('innerHeight', 500);
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current.inset).toBe(0);
});

it('keeps the header inside the same panned viewport as the composer', () => {
  const { result } = renderHook(usePhoneViewport);
  act(() => {
    Object.assign(viewport, { height: 500, offsetTop: 120 });
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toEqual({ inset: 224, top: 120 });
  act(() => {
    viewport.scale = 2;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toEqual({ inset: 0, top: 0 });
});
