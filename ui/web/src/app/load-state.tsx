"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../components/pill-button";
import { AlertLine } from "./alert-line";
import { Skeleton } from "../components/ui/skeleton";
import { Arrives } from "./motion";

/** A load from the Chat Service: in flight, answered, or failed with why. */
export type LoadState<T> = { status: "loading" } | { status: "loaded"; value: T } | { status: "failed"; error: string };

/**
 * Loads `load()` on mount and again whenever `key` changes, keeping what it showed until the new
 * answer arrives. `refresh` also keeps the last result visible, while `retry` starts from the loading state.
 */
export function useLoad<T>(load: () => Promise<T>, key: unknown) {
  const [result, setResult] = useState<{ state: LoadState<T>; key: unknown; attempt: number }>();
  const state: LoadState<T> = result?.state ?? { status: "loading" };
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () => {
      let current = true;
      load().then(
        (value) => current && setResult({ state: { status: "loaded", value }, key, attempt }),
        (failure: Error) => current && setResult({ state: { status: "failed", error: failure.message }, key, attempt }),
      );
      return () => {
        current = false;
      };
    },
    // `load` is a fresh closure each render; `key` names what it loads.
    [key, attempt],
  );

  const refresh = () => setAttempt((count) => count + 1);
  const retry = () => {
    setResult(undefined);
    refresh();
  };
  const update = (change: (value: T) => T) =>
    setResult((current) => current?.state.status === "loaded"
      ? { ...current, state: { status: "loaded", value: change(current.state.value) } }
      : current);
  const refreshing = result?.state.status === "loaded" &&
    (!Object.is(result.key, key) || result.attempt !== attempt);
  return { state, retry, refresh, refreshing, update };
}

/** A placeholder in the shape of text, shown while `label` loads. */
export function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="load-skeleton" role="status" aria-label={`Loading ${label}`}>
      <Skeleton className="load-skeleton-line" />
      <Skeleton className="load-skeleton-line" />
      <Skeleton className="load-skeleton-line" />
    </div>
  );
}

/** Why a load failed, with a Retry or another way on (ADR 0030: never an empty or default view). */
export function LoadFailed({ error, onRetry, action = "Retry" }: { error: string; onRetry: () => void; action?: string }) {
  return (
    <div className="load-failed">
      <AlertLine className="text-center">{error}</AlertLine>
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
