import type {} from '@testing-library/jest-dom/vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

import { cleanup } from '@testing-library/react';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect } from 'vitest';

import { installBrowserLocks } from './browser-locks';

expect.extend(matchers);

// Node's own localStorage, unusable without --localstorage-file, keeps Vitest from installing happy-dom's.
Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true });

// happy-dom lacks Web Locks; each test starts with none held. Source files can't import from `tests/`: the
// production image leaves it out (botcube/.dockerignore), and `next build` type-checks every test file.
beforeEach(installBrowserLocks);

afterEach(cleanup);
