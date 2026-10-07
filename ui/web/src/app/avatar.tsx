"use client";

import { useState } from "react";

const PERSON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="5" />
    <path d="M20 21a8 8 0 0 0-16 0" />
  </svg>
);

/** Below this size the monocle's chain blurs away, so it is dropped and the ring drawn thicker. */
const MONOCLE_CHAIN_MIN_SIZE = 40;

/** The agent's own avatar: a light-blue figure in a black homburg with a silver band, and graphite eyes and monocle. */
function AgentMark({ size }: { size: number }) {
  const chain = size >= MONOCLE_CHAIN_MIN_SIZE;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
      <path d="M60 46c24 0 40 14 40 33 0 19-16 31-40 31S20 98 20 79c0-19 16-33 40-33z" fill="#aec6e3" stroke="#6f93bf" strokeWidth="2.4" />
      <path d="M27 72c3-11 13-18 24-19-9 4-16 11-19 20z" fill="#c9daee" />
      <ellipse cx="60" cy="47" rx="30" ry="7" fill="#18191b" stroke="#6b6f77" strokeWidth="2.4" />
      <path d="M40 47c0-19 8-30 20-30s20 11 20 30c-6 2-13 3-20 3s-14-1-20-3z" fill="#202124" stroke="#6b6f77" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M40.4 40.6c5.9 1.9 12.6 2.9 19.6 2.9s13.7-1 19.6-2.9l.4 5.8c-6 2-13 3-20 3s-14-1-20-3z" fill="#d4d6da" />
      <path d="M52 21q8 5 16 0" stroke="#0e0f10" strokeWidth="2" fill="none" strokeLinecap="round" />
      <ellipse cx="50" cy="78" rx="3.6" ry="5" fill="#202124" />
      <ellipse cx="70" cy="78" rx="3.6" ry="5" fill="#202124" />
      <circle className="avatar-monocle" cx="70" cy="78" r="8.5" fill="none" stroke="#4a4d55" strokeWidth={chain ? 2.2 : 3.4} />
      {chain && <path className="avatar-monocle-chain" d="M77 83q3 8 0 16" stroke="#4a4d55" strokeWidth="1.2" fill="none" />}
    </svg>
  );
}

/**
 * A round avatar: the picture, else the emoji, else the agent's own avatar for the agent, else the
 * name's initial, else a generic person. A picture that fails to load falls back too.
 */
export function Avatar({
  picture,
  emoji,
  name,
  agent = false,
  size,
}: {
  picture?: string | undefined;
  emoji?: string | undefined;
  name?: string | undefined;
  agent?: boolean;
  size: number;
}) {
  const [broken, setBroken] = useState<string>();
  const showPicture = picture && picture !== broken;
  const showMark = agent && !showPicture && !emoji;
  return (
    // An initial or emoji sits at 7/16 of the avatar: 14px in the 32px chat avatar.
    <span className={showMark ? "avatar avatar-agent" : "avatar"} style={{ width: size, height: size, fontSize: (size * 7) / 16 }}>
      {showPicture ? (
        <img src={picture} alt="" onError={() => setBroken(picture)} />
      ) : showMark ? (
        <AgentMark size={size} />
      ) : (
        emoji || name?.charAt(0) || PERSON
      )}
    </span>
  );
}

/** The longest side of a picture: small enough for the Chat Service to keep. */
const PICTURE_SIZE = 256;

/** The chosen image, resized to at most PICTURE_SIZE on its longest side, as a WebP `data:` URL. */
export async function resizedPicture(file: File): Promise<string> {
  const image = await createImageBitmap(file).catch((cause: unknown) => {
    throw new Error(`${file.name} is not an image`, { cause });
  });
  const scale = Math.min(1, PICTURE_SIZE / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser cannot resize the picture");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  // Browsers that cannot encode WebP give a PNG, which the Chat Service accepts too.
  return canvas.toDataURL("image/webp", 0.9);
}
