"use client";

import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion } from "./collapse";

import { Button } from "../components/ui/button";
import { Avatar, resizedPicture } from "./avatar";

const MotionButton = motionElement.create(Button);

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
      <label className="button picture-upload">
        Upload {noun}
        <input type="file" accept="image/*" onChange={(event) => void choose(event.target.files?.[0])} />
      </label>
      <Presence>{picture && (
        <MotionButton {...presenceMotion} type="button" onClick={() => onChange(null)}>
          Remove {noun}
        </MotionButton>
      )}</Presence>
    </div>
  );
}
