import type {} from '@testing-library/jest-dom/vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

import { cleanup } from '@testing-library/react';
import { Storage } from 'happy-dom';
import { afterEach, expect } from 'vitest';

expect.extend(matchers);

// Node's own localStorage, unusable without --localstorage-file, keeps Vitest from installing happy-dom's.
Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true });

// The browser's Web Locks, which happy-dom lacks: one page, so each lock is granted in turn, and one request's
// failure is its own, never the next one's.
let locked: Promise<unknown> = Promise.resolve();
Object.defineProperty(navigator, 'locks', {
  value: {
    request: (_name: string, callback: () => unknown) => {
      const granted = locked.then(callback);
      locked = granted.catch(() => undefined);
      return granted;
    },
  },
  configurable: true,
});

afterEach(cleanup);
