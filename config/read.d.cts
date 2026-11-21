import type { z } from 'zod';
import type { botcubeConfig } from './schema.js' with { 'resolution-mode': 'import' };

export function readConfigSource(path: string, ErrorType?: new (message: string) => Error): unknown;
export function readConfig(path: string): z.input<typeof botcubeConfig>;
export function parseYaml(text: string, source: string, ErrorType?: new (message: string) => Error): unknown;
