"use client";

import { Fades } from "./motion";

import { Button, pillButtonVariants } from "../components/pill-button";
import { Input } from "@/components/ui/input";
import { Avatar, resizedPicture } from "./avatar";

/**
 * A picture being edited: the avatar, Upload (resized before `onChange`) and, while there is one,
 * Remove (`onChange(null)`). `noun` names it on the buttons: "picture" or "photo".
 */
export function PictureField({
  picture,
  emoji,
  name,
  agent = false,
  noun,
  size = 64,
  onChange,
  onError,
}: {
  picture: string | undefined;
  emoji?: string | undefined;
  name: string;
  /** The agent's picture: with no picture or emoji it shows the agent's own avatar. */
  agent?: boolean;
  noun: string;
  /** The avatar's size in pixels. */
  size?: number;
  onChange: (picture: string | null) => void;
  onError: (message: string) => void;
}) {
  const choose = async (file: File | undefined) => {
    if (!file) return;
    try {
      onChange(await resizedPicture(file));
    } catch (failure) {
      onError((failure as Error).message);
    }
  };
  return (
    <div className="picture-field">
      <Avatar picture={picture} emoji={emoji} name={name} agent={agent} size={size} />
      <label className={pillButtonVariants({ className: "picture-upload has-focus-visible:border-(--color-blue) has-focus-visible:ring-3 has-focus-visible:ring-(--color-blue)/50" })}>
        Upload {noun}
        <Input type="file" accept="image/*" onChange={(event) => void choose(event.target.files?.[0])} />
      </label>
      <Fades>{picture && (
        <Button type="button" onClick={() => onChange(null)}>
          Remove {noun}
        </Button>
      )}</Fades>
    </div>
  );
}
