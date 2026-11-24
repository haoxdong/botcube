import { Badge } from "../components/ui/badge";

export function UnreadDot({ unread, drawer = false }: { unread: boolean; drawer?: boolean }) {
  return unread ? <Badge className={drawer ? "chat-unread-dot drawer-unread-dot" : "chat-unread-dot"} role="img" aria-label={drawer ? "Unread chats" : "Unread"} /> : null;
}
