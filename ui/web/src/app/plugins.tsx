"use client";

import { BookOpen, Cable, Server, type LucideIcon } from "lucide-react";

import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { SectionLabel } from "../components/ui/section-label";
import { StatusPill } from "../components/ui/status-pill";

/** The kinds of plugin the agent will take, none of them available yet. */
const KINDS: readonly { name: string; none: string; Icon: LucideIcon; about: (agentName: string) => string }[] = [
  { name: "Connectors", none: "No connectors yet", Icon: Cable, about: (agent) => `Link your apps so ${agent} can read and act in them.` },
  { name: "MCP servers", none: "No MCP servers yet", Icon: Server, about: (agent) => `Add Model Context Protocol servers to give ${agent} new tools.` },
  { name: "Skills", none: "No skills yet", Icon: BookOpen, about: (agent) => `Teach ${agent} reusable workflows and know-how.` },
];

/** The Plugins screen the sidebar opens: each kind of plugin as a placeholder, as none is available yet. */
export function PluginsScreen({ agentName }: { agentName: string }) {
  return (
    <div className="plugins">
      <h1 className="plugins-title">Plugins</h1>
      <p className="plugins-intro">Extend what {agentName} can do.</p>
      {KINDS.map(({ name, none, Icon, about }) => (
        <section key={name} className="plugins-kind" aria-label={name}>
          <SectionLabel>{name}</SectionLabel>
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
