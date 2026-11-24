"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../components/pill-button";
import { Arrives } from "./motion";

/** A load from the Chat Service: in flight, answered, or failed with why. */
export type LoadState<T> = { status: "loading" } | { status: "loaded"; value: T } | { status: "failed"; error: string };

/**
 * Loads `load()` on mount and again whenever `key` changes, keeping what it showed until the new
 * answer arrives; `retry` loads again from the loading state, and `update` changes the loaded value.
 */
export function useLoad<T>(load: () => Promise<T>, key: unknown) {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () => {
      let current = true;
      load().then(
        (value) => current && setState({ status: "loaded", value }),
        (failure: Error) => current && setState({ status: "failed", error: failure.message }),
      );
      return () => {
        current = false;
      };
    },
    // `load` is a fresh closure each render; `key` names what it loads.
    [key, attempt],
  );

  const retry = () => {
    setState({ status: "loading" });
    setAttempt((count) => count + 1);
  };
  const update = (change: (value: T) => T) =>
    setState((current) => (current.status === "loaded" ? { status: "loaded", value: change(current.value) } : current));
  return { state, retry, update };
}

/** A placeholder in the shape of text, shown while `label` loads. */
export function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="load-skeleton" role="status" aria-label={`Loading ${label}`}>
      <span className="load-skeleton-line" />
      <span className="load-skeleton-line" />
      <span className="load-skeleton-line" />
    </div>
  );
}

/** Why a load failed, with a Retry or another way on (ADR 0030: never an empty or default view). */
export function LoadFailed({ error, onRetry, action = "Retry" }: { error: string; onRetry: () => void; action?: string }) {
  return (
    <div className="load-failed">
      <p className="load-failed-error" role="alert">
        {error}
      </p>
      <Button type="button" onClick={onRetry}>
        {action}
      </Button>
    </div>
  );
}

/** The loaded value through `children`; until then the skeleton, or why it failed with a Retry. One fade, in place. */
export function Loaded<T>({
  state,
  label,
  onRetry,
  children,
}: {
  state: LoadState<T>;
  label: string;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}) {
  return (
    <Arrives state={state.status} waiting={state.status === "loading"} className="load-state">
      {state.status === "loading" ? <LoadingSkeleton label={label} /> : state.status === "failed" ? <LoadFailed error={state.error} onRetry={onRetry} /> : children(state.value)}
    </Arrives>
  );
}

export function ChatLoadState({ linkedError, error, retry }: { linkedError: string | null; error: string | null; retry: () => void }) {
  const failure = linkedError ?? error;
  return failure === null ? <LoadingSkeleton label="Main Chat" /> : <LoadFailed error={failure} onRetry={retry} action={linkedError === null ? "Retry" : "Go to Main Chat"} />;
}
