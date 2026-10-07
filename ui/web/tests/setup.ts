import type {} from '@testing-library/jest-dom/vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

import { cleanup } from '@testing-library/react';
import { Storage } from 'happy-dom';
import { afterEach, expect } from 'vitest';

expect.extend(matchers);

// Node's own localStorage, unusable without --localstorage-file, keeps Vitest from installing happy-dom's.
Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true });

afterEach(cleanup);
