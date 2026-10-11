"use client";

import { useCallback, useEffect, useState } from "react";
import { describeError } from "./api";

export type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** Runs `load` on mount and whenever `deps` change; `reload` runs it again; `set` replaces the data. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): { state: Loaded<T>; reload: () => void; set: (data: T) => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load().then(
      (data) => !cancelled && setState({ status: "ready", data }),
      (error: unknown) => !cancelled && setState({ status: "error", message: describeError(error) }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller lists what `load` depends on
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const set = useCallback((data: T) => setState({ status: "ready", data }), []);
  return { state, reload, set };
}
