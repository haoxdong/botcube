"use client";

import { BookOpen, Cable, Package, SquareTerminal, type LucideIcon } from "lucide-react";

import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { StatusPill } from "../components/ui/status-pill";

/** The kinds of App the agent will take (botcube/GLOSSARY.md → Apps), in the decided order, none available yet. */
const KINDS: readonly { name: string; none: string; Icon: LucideIcon; about: (agentName: string) => string }[] = [
  { name: "Plugins", none: "No plugins yet", Icon: Package, about: () => "Connectors, terminal apps and skills, bundled as one app." },
  { name: "Connectors", none: "No connectors yet", Icon: Cable, about: (agent) => `Services like Gmail that ${agent} reaches over MCP.` },
  { name: "Terminal apps", none: "No terminal apps yet", Icon: SquareTerminal, about: (agent) => `Programs ${agent} runs from the shell on its computer.` },
  { name: "Skills", none: "No skills yet", Icon: BookOpen, about: (agent) => `Teach ${agent} reusable workflows and know-how.` },
];

/** The Apps screen the sidebar opens: each kind of App as a placeholder, as none is available yet. */
export function AppsScreen({ agentName }: { agentName: string }) {
  return (
    <div className="plugins">
      <h1 className="plugins-title">Apps</h1>
      <p className="plugins-intro">Extend what {agentName} can do.</p>
      {KINDS.map(({ name, none, Icon, about }) => (
        <section key={name} className="plugins-kind" aria-label={name}>
          <h2 className="section-label">{name}</h2>
          <ListRow className="plugins-placeholder" render={<div />}>
            <ListRowIcon>
              <Icon size={20} />
            </ListRowIcon>
            <ListRowText>
              <ListRowTitle>{none}</ListRowTitle>
              <ListRowDetail>{about(agentName)}</ListRowDetail>
            </ListRowText>
            <StatusPill className="plugins-soon">Coming soon</StatusPill>
          </ListRow>
        </section>
      ))}
    </div>
  );
}
