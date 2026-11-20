"use client";

import { BookOpen, Cable, Package, SquareTerminal, type LucideIcon } from "lucide-react";

import { ListRow, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { Badge } from "../components/ui/badge";

/** The kinds of App the agent will take (botcube/GLOSSARY.md → Apps), in the decided order, none available yet. */
const KINDS: readonly { name: string; none: string; Icon: LucideIcon }[] = [
  { name: "Plugins", none: "No plugins yet", Icon: Package },
  { name: "Connectors (MCP)", none: "No connectors yet", Icon: Cable },
  { name: "Terminal apps (CLI)", none: "No terminal apps yet", Icon: SquareTerminal },
  { name: "Skills", none: "No skills yet", Icon: BookOpen },
];

/** The Apps screen the sidebar opens: each kind of App as a placeholder, as none is available yet. */
export function AppsScreen({ agentName }: { agentName: string }) {
  return (
    <div className="plugins">
      <h1 className="plugins-title">Apps</h1>
      <p className="plugins-intro">Extend what {agentName} can do.</p>
      {KINDS.map(({ name, none, Icon }) => (
        <section key={name} className="plugins-kind" aria-label={name}>
          <h2 className="section-label">{name}</h2>
          <ListRow className="plugins-placeholder" render={<div />}>
            <ListRowIcon>
              <Icon size={20} />
            </ListRowIcon>
            <ListRowText>
              <ListRowTitle>{none}</ListRowTitle>
            </ListRowText>
            <Badge variant="secondary" className="plugins-soon">Coming soon</Badge>
          </ListRow>
        </section>
      ))}
    </div>
  );
}
