"use client";

import { Arrives, Fades } from "./motion";
import { useRef, useState, type KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { webUiPlugin } from "@bot-ui";
import type { AuthUiState } from "../plugin/index.js";
import { Avatar } from "./avatar";
import { ProfileEditor } from "./profile-editor";
import { AlertLine } from "./alert-line";
import { LoadFailed } from "./load-state";
import { useViewport } from "@/design-system/viewport";
import { Sheet } from "../components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
const UI_CONFIG = webUiPlugin.config;
const GUEST_NOTE = "Your work lives in this browser until you save it.";

export function GuestNotice({ onSignIn }: { onSignIn: () => void }) {
  return (
    <AlertLine tone="notice" role="note" className="guest-notice">
      {GUEST_NOTE}{" "}
      <Button type="button" variant="link" size="sm" onClick={onSignIn}>{UI_CONFIG.loginLabel}</Button>
    </AlertLine>
  );
}

/** The account's full and first name: nothing while the user loads, else the user's, else the account label. */
function accountNames({ user, userLoading }: AuthUiState): { name: string; firstName: string } {
  if (userLoading) return { name: "", firstName: "" };
  if (user?.name) return { name: user.name, firstName: user.name.split(" ")[0] ?? user.name };
  return { name: UI_CONFIG.accountLabel, firstName: UI_CONFIG.accountLabel };
}

export function UserMenu({ expanded, auth, onLogout }: {
  expanded: boolean;
  auth: AuthUiState;
  onLogout: () => void;
}) {
  const { user: userInfo, userLoading, editProfile: onEditProfile } = auth;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const isPhone = useViewport() === "phone";
  const { name, firstName } = accountNames(auth);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editor = onEditProfile && (
    <ProfileEditor
      user={userInfo}
      onSave={onEditProfile}
      onSaved={() => {
        setOpen(false);
        setEditing(false);
      }}
      onCancel={() => setEditing(false)}
    />
  );

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) setEditing(false); }}>
    <div className="user-menu">
      <Tooltip disabled={!userInfo?.name}>
        <TooltipTrigger render={<DropdownMenuTrigger ref={triggerRef} className="user-menu-trigger" aria-label="Account" />}>
          <Avatar picture={userInfo?.photo} name={name} blank={userLoading} size={isPhone && expanded ? 29 : 28} />
          <Fades>{expanded && <span className="sidebar-nav-label">{firstName}</span>}</Fades>
        </TooltipTrigger>
        <TooltipContent side="right">{userInfo?.name}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="user-menu-dropdown" finalFocus={editing && isPhone ? false : triggerRef}>
        <Arrives state={editing && editor && !isPhone ? "editing" : "account"}>{editing && editor && !isPhone ? (
          <div onKeyDown={keepKeysInEditor}>{editor}</div>
        ) : (
          <AccountItems
            auth={auth}
            name={name}
            onEdit={() => {
              setEditing(true);
              setOpen(!isPhone);
            }}
            onLogout={onLogout}
          />
        )}</Arrives>
      </DropdownMenuContent>
      {isPhone && editor && (
        <Sheet open={editing} onClose={() => setEditing(false)} title="Edit profile" container={null} finalFocus={triggerRef}>
          {editor}
        </Sheet>
      )}
    </div>
    </DropdownMenu>
  );
}

/** Keys typed in Edit profile stay its fields', out of the menu's arrow keys and typeahead; Escape still closes it. */
function keepKeysInEditor(event: KeyboardEvent) {
  if (event.key !== "Escape") event.stopPropagation();
}

function AccountItems({ auth, name, onEdit, onLogout }: {
  auth: AuthUiState;
  name: string;
  onEdit: () => void;
  onLogout: () => void;
}) {
  const { status: authStatus, loadFailure, user: userInfo, userLoading, editProfile: onEditProfile, login: onLogin, relink: onRelink } = auth;
  return (
    <>
      <Fades>{(authStatus === "authed" || userInfo) && (
        <>
          <div key="0" className="user-menu-header">
            <Avatar picture={userInfo?.photo} name={name} blank={userLoading} size={32} />
            <div className="user-menu-name">{name}</div>
          </div>
          <div key="1"><DropdownMenuSeparator /></div>
        </>
      )}</Fades>
      <Fades>{onEditProfile && (
        <div>
          <DropdownMenuItem closeOnClick={false} onClick={onEdit}>
            <Pencil size={16} aria-hidden />
            <span>Edit profile</span>
          </DropdownMenuItem>
        </div>
      )}</Fades>
      <Arrives state={loadFailure ? "failed" : authStatus}>{loadFailure ? (
        <LoadFailed error={loadFailure.error} onRetry={loadFailure.retry} />
      ) : authStatus === "authed" ? (
        <>
          <DropdownMenuItem onClick={() => onRelink()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
            <span>{UI_CONFIG.relinkLabel}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onLogout()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>{UI_CONFIG.logoutLabel ?? "Log out"}</span>
          </DropdownMenuItem>
        </>
      ) : (
        <>
        {auth.guest === true && (
          <p className="user-menu-note" role="note">{GUEST_NOTE} Sign in to save it.</p>
        )}
        <DropdownMenuItem onClick={() => onLogin()} disabled={authStatus === "loading"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          <span>{authStatus === "loading" ? "Connecting..." : UI_CONFIG.loginLabel}</span>
        </DropdownMenuItem>
        </>
      )}</Arrives>
    </>
  );
}
