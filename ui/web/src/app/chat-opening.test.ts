import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchOpening } from './chat-opening';

const frames: FrameRequestCallback[] = [];
const frame = (now = 16) => { for (const callback of frames.splice(0)) callback(now); };
const chat = (html: string, bottom = () => 757) => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top: bottom() - 100, bottom: bottom(), height: 100 }) as DOMRect);
  return wrapper;
};

beforeEach(() => {
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The chat surface's scroll view keeps to its latest message a frame after a reply grows, as a diagram rendering does,
// so a chat that opened on the frame its reply grew showed that message 20px down for a frame.
it('opens only once the latest message has held still since the frame before', () => {
  let bottom = 757;
  const wrapper = chat('<div class="copilotKitMessage"></div>', () => bottom);
  const opened = vi.fn();
  watchOpening(() => wrapper, opened);

  frame();
  expect(opened).not.toHaveBeenCalled();
  bottom = 777;
  frame();
  expect(opened).not.toHaveBeenCalled();
  bottom = 757;
  frame();
  expect(opened).not.toHaveBeenCalled();
  frame();
  expect(opened).toHaveBeenCalledOnce();
});

// Under a slow CPU the diagram rendered over a second after the chat mounted, and the chat opened on that same frame,
// its 1s wait for a rendered chat counted from the mount, before the scroll view had kept to the grown reply.
it('waits for the latest message to hold still after a reply renders late', () => {
  let bottom = 757;
  const wrapper = chat('<div class="copilotKitMessage copilotKitAssistantMessage"><div data-streamdown="mermaid-block"></div></div>', () => bottom);
  const opened = vi.fn();
  vi.spyOn(performance, 'now').mockReturnValue(0);
  watchOpening(() => wrapper, opened);

  frame(500);
  frame(1500);
  expect(opened).not.toHaveBeenCalled();
  wrapper.querySelector('[data-streamdown="mermaid-block"]')?.insertAdjacentHTML('beforeend', '<div data-streamdown="mermaid"></div>');
  bottom = 777;
  frame(1516);
  expect(opened).not.toHaveBeenCalled();
  bottom = 757;
  frame(1532);
  expect(opened).not.toHaveBeenCalled();
  frame(1548);
  expect(opened).toHaveBeenCalledOnce();
});

// A reply's file link shows "(loading)" on one line, then its file's state: a download link, or a "could not download"
// alert of up to three lines. Opened while it loaded, the chat at its end moved 44px when the link resolved.
it('waits for a reply file link to resolve before opening', () => {
  const wrapper = chat('<div class="copilotKitMessage copilotKitAssistantMessage"><span data-reply-file-loading>[1] (loading)</span></div>');
  const opened = vi.fn();
  vi.spyOn(performance, 'now').mockReturnValue(0);
  watchOpening(() => wrapper, opened);

  frame(16);
  frame(32);
  frame(1300);
  expect(opened).not.toHaveBeenCalled();
  wrapper.querySelector('[data-reply-file-loading]')?.replaceWith(Object.assign(document.createElement('span'), { textContent: '[1] could not download' }));
  frame(1316);
  frame(1332);
  expect(opened).toHaveBeenCalledOnce();
});

// A chat's history is no message arriving: what it held when it opened shows at once, and only what arrives later
// fades in.
it('marks the messages a chat holds as it opens, so its history shows without the entrance fade', () => {
  const wrapper = chat('<div class="copilotKitMessage"></div><div class="copilotKitMessage"></div>');
  const opened = vi.fn(() => expect(wrapper.querySelectorAll('.copilotKitMessage:not([data-opened])')).toHaveLength(0));
  watchOpening(() => wrapper, opened);

  frame();
  frame();
  expect(opened).toHaveBeenCalledOnce();
  wrapper.insertAdjacentHTML('beforeend', '<div class="copilotKitMessage"></div>');
  expect(wrapper.querySelector('.copilotKitMessage:last-child')?.hasAttribute('data-opened')).toBe(false);
});

it('waits for a reply image to load before opening', () => {
  const wrapper = chat('<div class="copilotKitMessage copilotKitAssistantMessage"><div class="reply-image"><img></div></div>');
  const opened = vi.fn();
  watchOpening(() => wrapper, opened);

  const image = wrapper.querySelector('img');
  Object.defineProperty(image, 'complete', { configurable: true, value: false });
  frame();
  frame();
  expect(opened).not.toHaveBeenCalled();
  image?.setAttribute('data-loaded', '');
  frame();
  frame();
  expect(opened).toHaveBeenCalledOnce();
});
