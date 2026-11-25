// The Fluent parts the Agent Computer draws, once in a page's CSS and once in a frame of Fluent's own: the story
// `BotCube/Computer Fluent` compares the two. Kept here, as every Fluent import is (ADR 0093).
import {
  Button,
  createDOMRenderer,
  FluentProvider,
  RendererProvider,
  Text,
  Toolbar,
  ToolbarToggleButton,
  webLightTheme,
} from '@fluentui/react-components';
import { Dismiss16Regular, Folder24Filled, Maximize16Regular, Subtract16Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/** The Fluent controls the computer's shell uses (PR (a)); later parts add theirs here. */
function Controls() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: 12 }}>
      <span data-control="Button" style={{ display: 'flex' }}>
        <Button appearance="subtle" aria-label="Minimise" icon={<Subtract16Regular />} />
        <Button appearance="subtle" aria-label="Maximise" icon={<Maximize16Regular />} />
        <Button appearance="subtle" aria-label="Close" icon={<Dismiss16Regular />} />
        <Button>Take over</Button>
      </span>
      <span data-control="Toolbar">
        <Toolbar aria-label="Sample taskbar" checkedValues={{ app: ['files'] }}>
          <ToolbarToggleButton name="app" value="files" appearance="subtle" aria-label="Files" icon={<Folder24Filled />} />
          <ToolbarToggleButton name="app" value="chrome" appearance="subtle" aria-label="Chrome" icon={<Folder24Filled />} />
        </Toolbar>
      </span>
      <span data-control="Text">
        <Text>09:41</Text>
        <Text size={200} truncate wrap={false}>workspace — zsh</Text>
      </span>
    </div>
  );
}

/** Fluent's reference: the same controls in a frame with no CSS but Fluent's own. */
export function FluentReference() {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const document = frame?.contentDocument;
    if (document?.body) setBody(document.body);
  }, [frame]);
  const document = body?.ownerDocument;
  return (
    <iframe ref={setFrame} title="Fluent reference" data-sample="reference" style={{ width: 420, height: 260, border: 0 }}>
      {body !== null && document !== undefined && createPortal(
        <RendererProvider renderer={createDOMRenderer(document)} targetDocument={document}>
          <FluentProvider theme={webLightTheme} targetDocument={document}><Controls /></FluentProvider>
        </RendererProvider>,
        body,
      )}
    </iframe>
  );
}

/** The same controls drawn in the page, under its CSS, in the computer's Fluent root. */
export function FluentInPage() {
  return <FluentProvider theme={webLightTheme} className="agent-computer-fluent"><Controls /></FluentProvider>;
}
