import { m as motionElement } from "framer-motion";
import { Fragment, useLayoutEffect, useRef } from 'react';
import { Presence, presenceMotion } from "../app/collapse";

export interface ShellCommand {
  command: string;
  output: string;
}

/** The Agent Computer's Terminal: the shell commands the agent ran, each under its prompt with its output. */
export function Terminal({ commands, error, prompt }: { commands: readonly ShellCommand[]; error: string | null; prompt: string }) {
  const log = useRef<HTMLDivElement>(null);
  // It opens at the latest output and follows new output, until the user scrolls up to read; scrolling back down follows again.
  const following = useRef(true);
  useLayoutEffect(() => {
    if (log.current !== null && following.current) log.current.scrollTop = log.current.scrollHeight;
  }, [commands, error]);
  if (error !== null) return <p className="agent-computer-error" role="alert">{error}</p>;
  return (
    <div
      ref={log}
      className="agent-computer-terminal"
      role="log"
      aria-label="Terminal"
      onScroll={({ currentTarget: { scrollHeight, scrollTop, clientHeight } }) => {
        following.current = scrollHeight - scrollTop - clientHeight < 2;
      }}
    >
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
    </div>
  );
}
