import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AttachmentHoverCard, AttachmentHoverCardContent, AttachmentHoverCardTrigger } from './ui/attachments';

// Stock AI Elements attachments.tsx is written for Radix: it sets a 0 ms openDelay and closeDelay on the HoverCard root.
// base-nova's HoverCard is Base UI's PreviewCard, whose root has no delays; its Trigger has them, 600 ms by default.
// So the stock bytes fail tsc, and at run time drop the 0 ms, which is why ui/attachments.tsx sets them on the Trigger.
describe('stock gap: AttachmentHoverCard delays on base-nova', () => {
  it("opens a file's hover card at once, not after Base UI's 600 ms default", async () => {
    render(
      <AttachmentHoverCard>
        <AttachmentHoverCardTrigger render={<span />}>report.csv</AttachmentHoverCardTrigger>
        <AttachmentHoverCardContent>Upload failed</AttachmentHoverCardContent>
      </AttachmentHoverCard>,
    );
    await userEvent.hover(screen.getByText('report.csv'));
    expect(await screen.findByText('Upload failed', {}, { timeout: 200 })).toBeInTheDocument();
  });
});
