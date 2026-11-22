"use client";

import { m as motionElement } from "motion/react";
import { Presence, presenceMotion } from "./collapse";

import { Button } from "../components/pill-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      <label className={buttonVariants({ variant: "secondary", className: "pill-button picture-upload rounded-full has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50" })}>
        Upload {noun}
        <Input type="file" accept="image/*" onChange={(event) => void choose(event.target.files?.[0])} />
      </label>
      <Presence>{picture && (
        <MotionButton {...presenceMotion} type="button" onClick={() => onChange(null)}>
          Remove {noun}
        </MotionButton>
      )}</Presence>
    </div>
  );
}
