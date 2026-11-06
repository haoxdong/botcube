"use client";

import { Swap, Presence, presenceMotion, Layout } from "./collapse";

import { m as motionElement } from "framer-motion";
import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { webUiPlugin } from "@cartridge-ui";
import type { AuthUiState } from "../cartridge/index.js";
import { Avatar } from "./avatar";
import { ProfileEditor } from "./profile-editor";
import { LoadFailed } from "./load-state";
import { useIsPhone } from "./phone-query";
import { Sheet } from "../components/ui/sheet";
const UI_CONFIG = webUiPlugin.config;

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
  const isPhone = useIsPhone();
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
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) setEditing(false); }}>
    <div className="user-menu">
      <Popover.Trigger
        ref={triggerRef}
        className={`user-menu-trigger${open ? " menu-open" : ""}`}
        aria-label="Account"
        data-tooltip={userInfo?.name}
      >
        <Avatar picture={userInfo?.photo} name={name} blank={userLoading} size={isPhone && expanded ? 29 : 28} />
        <Presence>{expanded && <motionElement.span {...presenceMotion} className="sidebar-nav-label">{firstName}</motionElement.span>}</Presence>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="standard-popup-positioner" side="top" align="start" sideOffset={8}>
          <Popover.Popup render={<Layout layoutDependency={editing} />} className="user-menu-dropdown standard-popup" finalFocus={editing && isPhone ? false : triggerRef}>
        <Swap state={editing && editor && !isPhone ? "editing" : "account"}>{editing && editor && !isPhone ? (
          editor
        ) : (
          <AccountItems
            auth={auth}
            name={name}
            onEdit={() => {
              setEditing(true);
              setOpen(!isPhone);
            }}
            onLogout={onLogout}
            close={() => setOpen(false)}
          />
        )}</Swap>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
      {isPhone && editor && (
        <Sheet open={editing} onClose={() => setEditing(false)} title="Edit profile" container={null} finalFocus={triggerRef}>
          {editor}
        </Sheet>
      )}
    </div>
    </Popover.Root>
  );
}

function AccountItems({ auth, name, onEdit, onLogout, close }: {
  auth: AuthUiState;
  name: string;
  onEdit: () => void;
  onLogout: () => void;
  close: () => void;
}) {
  const { status: authStatus, loadFailure, user: userInfo, userLoading, editProfile: onEditProfile, login: onLogin, relink: onRelink } = auth;
  return (
    <>
      <Presence>{(authStatus === "authed" || userInfo) && (
        <>
          <motionElement.div {...presenceMotion} key="0" className="user-menu-header">
            <Avatar picture={userInfo?.photo} name={name} blank={userLoading} size={32} />
            <div className="user-menu-name">{name}</div>
          </motionElement.div>
          <motionElement.div {...presenceMotion} key="1" className="user-menu-sep" />
        </>
      )}</Presence>
      <Presence>{onEditProfile && (
        <motionElement.button {...presenceMotion} className="user-menu-item" onClick={onEdit}>
          <Pencil size={16} aria-hidden />
          <span>Edit profile</span>
        </motionElement.button>
      )}</Presence>
      <Swap state={loadFailure ? "failed" : authStatus}>{loadFailure ? (
        <LoadFailed error={loadFailure.error} onRetry={loadFailure.retry} />
      ) : authStatus === "authed" ? (
        <>
          <button className="user-menu-item" onClick={() => { onRelink(); close(); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
            <span>{UI_CONFIG.relinkLabel}</span>
          </button>
          <button className="user-menu-item" onClick={() => { onLogout(); close(); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>{UI_CONFIG.logoutLabel ?? "Log out"}</span>
          </button>
        </>
      ) : (
        <button
          className="user-menu-item"
          onClick={() => { onLogin(); close(); }}
          disabled={authStatus === "loading"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          <span>{authStatus === "loading" ? "Connecting..." : UI_CONFIG.loginLabel}</span>
        </button>
      )}</Swap>
    </>
  );
}
