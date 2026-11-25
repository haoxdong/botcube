// File Explorer's Delete confirmation, a stock Fluent Dialog (ADR 0093).
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components';
import type { FilesItem } from './files-items';

/** Delete's question: for one file by its name, for several by their count. */
export function DeleteDialog({ shown, onCancel, onConfirm, onGone }: {
  /** The files Delete waits to delete, and whether the dialog is open; they stay until its close motion has ended. */
  shown: { items: readonly FilesItem[]; open: boolean } | null;
  onCancel: () => void;
  onConfirm: () => void;
  onGone: () => void;
}) {
  const items = shown?.items ?? [];
  const [only] = items;
  const one = items.length === 1 && only !== undefined;
  return (
    <Dialog
      open={shown?.open === true}
      modalType="alert"
      onOpenChange={(_, data) => { if (!data.open) onCancel(); }}
      surfaceMotion={{ onMotionFinish: (_, { direction }) => { if (direction === 'exit') onGone(); } }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{one ? 'Delete file' : 'Delete multiple items'}</DialogTitle>
          <DialogContent>{one ? `Delete “${only.name}”? This can't be undone.` : `Delete ${items.length} items? This can't be undone.`}</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" onClick={onConfirm}>Delete</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
