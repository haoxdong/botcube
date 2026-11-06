export function UnreadDot({ unread, drawer = false }: { unread: boolean; drawer?: boolean }) {
  return unread ? <span className={drawer ? "chat-unread-dot drawer-unread-dot" : "chat-unread-dot"} role="img" aria-label={drawer ? "Unread chats" : "Unread"} /> : null;
}
