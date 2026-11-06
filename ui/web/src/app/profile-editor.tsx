"use client";

import { useState, type FormEvent } from "react";
import type { AuthUiState, AuthUser } from "../cartridge/index.js";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { PictureField } from "./picture-field";
import { Fade } from "./collapse";

/** The user's display name and photo, edited in the account menu: `onSaved` after a save, `onCancel` without one. */
export function ProfileEditor({
  user,
  onSave,
  onSaved,
  onCancel,
}: {
  user: AuthUser | undefined;
  onSave: NonNullable<AuthUiState["editProfile"]>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(user?.name ?? "");
  /** The chosen photo: null to remove it, undefined to keep the user's. */
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const shown = photo === undefined ? user?.photo : (photo ?? undefined);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await onSave({ name, photo });
      onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <form className="profile-editor" aria-label="Edit profile" onSubmit={(event) => void save(event)}>
      <PictureField picture={shown} name={name} noun="photo" onChange={setPhoto} onError={setError} />
      <Field label="Display name">
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Fade open={error !== null} className="profile-editor-error" role="alert">{error}</Fade>
      <div className="profile-editor-actions">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}
