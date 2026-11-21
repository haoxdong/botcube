import { m as motionElement } from "motion/react";
import { Fragment } from 'react';
import { Conversation, ConversationContent } from "../components/ui/conversation";
import { Presence, presenceMotion } from "../app/collapse";

export interface ShellCommand {
  command: string;
  output: string;
}

/**
 * The Agent Computer's Terminal: the shell commands the agent ran, each under its prompt with its output. The stock
 * Conversation opens it at the latest output and follows new output, until the user scrolls up to read; scrolling back
 * to the end follows again. Output lands at once, as a terminal's does.
 */
export function Terminal({ commands, error, prompt }: { commands: readonly ShellCommand[]; error: string | null; prompt: string }) {
  if (error !== null) return <p className="agent-computer-error" role="alert">{error}</p>;
  return (
    <Conversation className="agent-computer-terminal" initial="instant" resize="instant" aria-label="Terminal">
      <ConversationContent className="agent-computer-terminal-content block gap-0 p-0">
        <Presence>{commands.length === 0 ? (
          <motionElement.div {...presenceMotion} className="agent-computer-terminal-empty">No commands yet</motionElement.div>
        ) : (
          commands.map(({ command, output }, index) => (
            <Fragment key={index}>
              <div className="agent-computer-terminal-line">{`${prompt} ${command}`}</div>
              <div className="agent-computer-terminal-output">{output}</div>
            </Fragment>
          ))
        )}</Presence>
      </ConversationContent>
    </Conversation>
  );
}
