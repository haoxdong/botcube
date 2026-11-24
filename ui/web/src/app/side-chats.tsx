"use client";


import { Arrives, Fades, Fold, Folds } from "./motion";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { contextMenuKey } from "./context-menu-key";
import { ChevronDown, ChevronRight, Clock, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { isUnread, type ConversationEntry } from "./conversations";
import { withStorage } from "./main-chat-copy";
import { SideChatNameField } from "./side-chat-name-field";
import { UnreadDot } from "./unread-dot";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import type { AuthUiState } from "../plugin/index.js";
import type { useSessionNavigation } from "./session-navigation";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Item } from "@/components/ui/item";
import { AlertLine } from "./alert-line";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NATIVE_SIDE_CHAT_BODY = process.env.NEXT_PUBLIC_NATIVE_SIDE_CHAT_BODY === "1";
const BodyPresence = NATIVE_SIDE_CHAT_BODY ? Fragment : Fades;

type Navigation = ReturnType<typeof useSessionNavigation>;
const SIDE_CHATS_BATCH = 5;
export function SideChats({ accountId, activeId, pluginsOpen, visible, entries: sideChats, listed, error: sideChatsError, rename: renameSideChat, remove: handleDeleteConversation, select: handleSelectConversation, create: handleNewConversation, showChat }: {
  accountId: AuthUiState["accountId"];
  activeId: string | null;
  pluginsOpen: boolean;
  visible: boolean;
  entries: Navigation["sideChats"]["entries"];
  listed: Navigation["sideChats"]["listed"];
  error: Navigation["sideChats"]["error"];
  rename: Navigation["renameSideChat"];
  remove: Navigation["deleteSideChat"];
  select: Navigation["selectSideChat"];
  create: Navigation["newSideChat"];
  showChat: () => void;
}) {
  const sideChatsListId = useId();
  const [sideChatsPreference, setSideChatsPreference] = useState<{ accountId: typeof accountId; collapsed: boolean } | null>(null);
  const sideChatsCollapsed = sideChatsPreference !== null && sideChatsPreference.accountId === accountId
    ? sideChatsPreference.collapsed : false;

  useEffect(() => {
    const collapsed = accountId !== undefined && withStorage(() => localStorage.getItem(`botcube.side-chats-collapsed:${accountId}`)) === 'true';
    setSideChatsPreference(previous => previous !== null && previous.accountId === accountId
      ? previous : { accountId, collapsed });
  }, [accountId]);

  function toggleSideChats(): void {
    const collapsed = !sideChatsCollapsed;
    setSideChatsPreference({ accountId, collapsed });
    if (accountId !== undefined) {
      withStorage(() => localStorage.setItem(`botcube.side-chats-collapsed:${accountId}`, String(collapsed)));
    }
  }
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [moreBatches, setMoreBatches] = useState(0);
  const firstShown = Math.max(SIDE_CHATS_BATCH, sideChats.findIndex(c => c.id === activeId) + 1);
  const shownSideChats = sideChats.slice(0, firstShown + moreBatches * SIDE_CHATS_BATCH);
  // Each batch Show more reveals, and the next one, held closed so that its reveal is an open the fold grows for.
  const more = Array.from({ length: moreBatches + 1 }, (_, index) =>
    sideChats.slice(firstShown + index * SIDE_CHATS_BATCH, firstShown + (index + 1) * SIDE_CHATS_BATCH)).filter((batch) => batch.length > 0);
  const [lastError, setLastError] = useState(sideChatsError);
  if (sideChatsError !== null && sideChatsError !== lastError) setLastError(sideChatsError);
  // Show more can reveal the last batch and unmount itself, so focus moves to the first row it revealed.
  const revealedSideChat = useRef<string | null>(null);
  const finishRename = (conversation: ConversationEntry, name: string | null) => {
    setRenamingId(null);
    if (name !== null && name.trim() && name !== conversation.title) void renameSideChat(conversation, name);
  };

  const row = (c: ConversationEntry) => (
    <SideChatRow key={c.id} title={c.title}
      className={["sidebar-item", !pluginsOpen && c.id === activeId && "sidebar-item-active"].filter(Boolean).join(" ")}
      rename={() => setRenamingId(c.id)} remove={() => { void handleDeleteConversation(c); }}>
      <Arrives state={renamingId === c.id ? "editing" : "name"} className="sidebar-item-content">{renamingId === c.id ? (
        <SideChatNameField title={c.title} onDone={(name) => finishRename(c, name)} />
      ) : (
        <Item render={<button type="button" />} className="sidebar-item-btn flex-nowrap gap-0 rounded-(--radius-md) text-[length:inherit]" data-testid={`side-chat-${c.id}`}
          ref={(button) => { if (button && c.id === revealedSideChat.current) { revealedSideChat.current = null; button.focus(); } }}
          onClick={() => { showChat(); void handleSelectConversation(c); }}>
          <Fades>{c.scheduled && <Clock className="sidebar-item-icon" role="img" aria-label="Scheduled" aria-hidden={false} />}</Fades>
          <span className="sidebar-item-title">{c.title}</span>
          <UnreadDot unread={isUnread(c)} />
        </Item>
      )}</Arrives>
    </SideChatRow>
  );

  const body = sideChatsPreference !== null && (
    <Folds open={!sideChatsCollapsed} data-native-entry={NATIVE_SIDE_CHAT_BODY || undefined} className="side-chats-body">
      <div className="sidebar-list" id={sideChatsListId}>
        <Fades>{listed && sideChats.length === 0 && sideChatsError === null && (
          <Empty className="sidebar-empty">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
            </svg>
            <EmptyTitle className="sidebar-empty-title">Start a side chat</EmptyTitle>
            <EmptyDescription>Side chats are an optional way to organize your conversations by topic.</EmptyDescription>
          </Empty>
        )}</Fades>
        {shownSideChats.slice(0, firstShown).map(row)}
        {more.map((batch, index) => (
          <Fold key={index} open={index < moreBatches}>{batch.map(row)}</Fold>
        ))}
        <Fades>{shownSideChats.length < sideChats.length && (
          <button
            className="sidebar-show-more"
            onClick={() => {
              revealedSideChat.current = sideChats[shownSideChats.length]?.id ?? null;
              setMoreBatches(moreBatches + 1);
            }}
          >
            Show more
          </button>
        )}</Fades>
      </div>
    </Folds>
  );

  return (
        <div className="sidebar-recents">
          <div className="sidebar-section-header">
            <button className="sidebar-side-chats-toggle" onClick={toggleSideChats} aria-expanded={!sideChatsCollapsed} aria-controls={sideChatsListId}>
              <span>Side chats</span>
              <Fades>{sideChatsCollapsed ? <ChevronRight key="0" aria-hidden /> : <ChevronDown key="1" aria-hidden />}</Fades>
            </button>
            <Tooltip>
              <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-lg" className="sidebar-new-chat" onClick={() => { showChat(); void handleNewConversation(); }} aria-label="New side chat" />}>
                <Plus aria-hidden />
              </TooltipTrigger>
              <TooltipContent>New side chat</TooltipContent>
            </Tooltip>
          </div>
          <Fold open={sideChatsError !== null}><AlertLine className="sidebar-error" hidden={!visible}>{lastError}</AlertLine></Fold>
          <BodyPresence>{body}</BodyPresence>

        </div>

  );
}

/** A side chat's actions, from a right-click or long press on its row (stock ContextMenu) or from its "…" (stock
 * DropdownMenu): the same two items either way. */
function SideChatRow({ title, className, children, rename, remove }: {
  title: string; className: string; children: ReactNode; rename: () => void; remove: () => void;
}) {
  const restoreFocus = useRef(true);
  const opened = (open: boolean) => { if (open) restoreFocus.current = true; };
  const popup = { className: "side-chat-menu", "aria-label": title, "aria-labelledby": "", finalFocus: () => restoreFocus.current };
  const onRename = () => { restoreFocus.current = false; rename(); };
  const onRemove = () => { restoreFocus.current = false; remove(); };
  return (
    <ContextMenu onOpenChange={opened}>
      <ContextMenuTrigger className={className} onKeyDown={contextMenuKey}>
        {children}
        <DropdownMenu onOpenChange={opened}>
          <Tooltip>
            <TooltipTrigger render={<DropdownMenuTrigger className="sidebar-item-more" aria-label="Side chat actions" />}>
              <Ellipsis size={16} aria-hidden />
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent {...popup}>
            <DropdownMenuItem onClick={onRename}><Pencil aria-hidden />Rename</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}><Trash2 aria-hidden />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent {...popup}>
        <ContextMenuItem onClick={onRename}><Pencil aria-hidden />Rename</ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={onRemove}><Trash2 aria-hidden />Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
