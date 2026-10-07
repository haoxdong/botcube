"use client";

import { Button } from "../components/ui/button";
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
  onChange,
  onError,
}: {
  picture: string | undefined;
  emoji?: string | undefined;
  name: string;
  /** The agent's picture: with no picture or emoji it shows the agent's own avatar. */
  agent?: boolean;
  noun: string;
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
      <Avatar picture={picture} emoji={emoji} name={name} agent={agent} size={64} />
      <label className="button picture-upload">
        Upload {noun}
        <input type="file" accept="image/*" onChange={(event) => void choose(event.target.files?.[0])} />
      </label>
      {picture && (
        <Button type="button" onClick={() => onChange(null)}>
          Remove {noun}
        </Button>
      )}
    </div>
  );
}
