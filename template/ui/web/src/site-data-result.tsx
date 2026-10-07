"use client";

import { useCopilotKit, useRenderTool } from '@copilotkit/react-core/v2/headless';
import { Database } from 'lucide-react';
import React, { type ComponentType } from 'react';

/** The shell tool's arguments: the command the agent runs. */
const SHELL_ARGUMENTS = {
  '~standard': {
    version: 1,
    vendor: 'botcube-template',
    validate: (value: unknown) =>
      typeof value === 'object' && value !== null && 'command' in value && typeof value.command === 'string'
        ? { value: { command: value.command } }
        : { issues: [{ message: 'The shell call names no command' }] },
  },
} as const;

interface Item {
  name: string;
  value: number;
}

/** deepagents' execute tool reports a non-zero exit only as this trailer on an otherwise successful result. */
const FAILED_COMMAND = /\n\[Command failed with exit code \d+\]/;

/** The items a successful `template-cli data` printed; any other output is not the site's data, and says so. */
function siteItems(result: string): Item[] {
  let data: unknown;
  try {
    data = JSON.parse(result);
  } catch (cause) {
    throw new Error('Template site data is not JSON', { cause });
  }
  const items: unknown = typeof data === 'object' && data !== null && 'items' in data ? data.items : undefined;
  if (Array.isArray(items) && items.every((item): item is Item =>
    typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string' && 'value' in item && typeof item.value === 'number')) {
    return items;
  }
  throw new Error('Template site data has no items');
}

/** The card for a finished `template-cli data` call: its items, or why its output is not the site's data. */
function SiteData({ result }: { result: string }) {
  let items: Item[];
  try {
    items = siteItems(result);
  } catch (cause) {
    return <p className="template-error" role="alert">{(cause as Error).message}</p>;
  }
  return (
    <section className="template-site-data" aria-label="Template site data">
      <header className="template-site-data-head">
        <span className="template-site-data-icon" aria-hidden="true"><Database /></span>
        <span className="template-site-data-title">Template site</span>
        <span className="template-site-data-count">{items.length === 1 ? '1 item' : `${items.length} items`}</span>
      </header>
      <ul className="template-site-data-items">
        {items.map((item) => (
          <li key={item.name} className="template-site-data-item">
            <span className="template-site-data-name">{item.name}</span>
            <span className="template-site-data-value">{item.value.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The template's tool-result renderer: each shell call keeps the chat's own row, and a `template-cli data` call
 * that answered shows the site's items as a card under it.
 */
export function SiteDataResult() {
  const { copilotkit } = useCopilotKit();
  useRenderTool({
    name: 'execute',
    parameters: SHELL_ARGUMENTS,
    render: (props) => {
      // The chat's own renderer for every tool call, with its Running, Stopped and failed states. It takes the same
      // call, its arguments as `args`; CopilotKit types its status as an enum of these same strings.
      const Row = copilotkit.renderToolCalls.find((renderer) => renderer.name === '*')?.render as
        | ComponentType<typeof props & { args: typeof props.parameters }>
        | undefined;
      if (!Row) throw new Error("The chat registered no tool-call renderer for the template's to extend");
      // A failed command is not the site's data: the chat's own row shows its output and failure.
      const data = props.status === 'complete' && props.parameters.command.trim() === 'template-cli data' && !FAILED_COMMAND.test(props.result);
      return (
        <>
          <Row {...props} args={props.parameters} />
          {data && <SiteData result={props.result} />}
        </>
      );
    },
  }, []);
  return null;
}
