import { commands } from 'vitest/browser';

/** What a stand-in script host serves: a script's text, or a package file such as a CDN would serve. */
export type ScriptSource = { body: string } | { module: string };

declare module 'vitest/browser' {
  interface BrowserCommands {
    serveScript: (url: string, source: ScriptSource) => Promise<void>;
    scriptRequests: (url: string) => Promise<number>;
    stopServingScript: (url: string) => Promise<void>;
  }
}

/**
 * Stands in for script hosts, CDN or not, so a story needs no network: the browser still applies origins and Content
 * Security Policy to the real URLs. Returns the cleanup for a story's `beforeEach`.
 */
export async function serveScripts(scripts: Record<string, ScriptSource>) {
  await Promise.all(Object.entries(scripts).map(([url, source]) => commands.serveScript(url, source)));
  return async () => {
    await Promise.all(Object.keys(scripts).map((url) => commands.stopServingScript(url)));
  };
}

/** How many requests a stand-in host has had for `url` since `serveScripts`. */
export const scriptRequests = (url: string) => commands.scriptRequests(url);
