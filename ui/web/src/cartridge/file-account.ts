export const FILE_ACCOUNT_LOCK = 'botcube.file-account';

export function attachmentAccountEpoch(): string | null {
  return typeof window === 'undefined' ? null : localStorage.getItem(FILE_ACCOUNT_LOCK);
}

export function invalidateAttachmentAccount(): void {
  localStorage.setItem(FILE_ACCOUNT_LOCK, crypto.randomUUID());
  window.dispatchEvent(new Event(FILE_ACCOUNT_LOCK));
}

export function subscribeAttachmentAccount(listener: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (event.key === FILE_ACCOUNT_LOCK || event.key === null) listener();
  };
  window.addEventListener('storage', changed);
  window.addEventListener(FILE_ACCOUNT_LOCK, listener);
  return () => {
    window.removeEventListener('storage', changed);
    window.removeEventListener(FILE_ACCOUNT_LOCK, listener);
  };
}
