"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { authClient } from "@/lib/auth/client";
import type { Session } from "@/lib/auth/types";
import { useAuth } from "./auth-provider";

const WARNING_MS = 2 * 60_000;
/** While the owner is active the session is refreshed at most this often. */
const REFRESH_EVERY_MS = 60_000;

/**
 * Keeps a signed-in session alive while the owner is working, warns two
 * minutes before an idle one ends, and signs out when it does (§11, 2.2.1).
 */
export function SessionKeeper({ session }: { session: Session }) {
  const { refresh, signOut } = useAuth();
  const [remainingMs, setRemainingMs] = useState(() => session.expiresAt - Date.now());
  const expiresAt = useRef(session.expiresAt);
  expiresAt.current = session.expiresAt;
  const warning = remainingMs <= WARNING_MS;
  const warningRef = useRef(warning);
  warningRef.current = warning;

  useEffect(() => {
    const tick = () => {
      const remaining = expiresAt.current - Date.now();
      setRemainingMs(remaining);
      if (remaining <= 0) signOut("expired");
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [signOut, session.expiresAt]);

  useEffect(() => {
    const lifetimeMs = authClient.sessionSeconds * 1000;
    let busy = false;
    const onActivity = () => {
      // Once the warning is up, staying signed in is an explicit choice.
      if (busy || warningRef.current) return;
      if (lifetimeMs - (expiresAt.current - Date.now()) < REFRESH_EVERY_MS) return;
      busy = true;
      void refresh().finally(() => {
        busy = false;
      });
    };
    window.addEventListener("keydown", onActivity);
    window.addEventListener("pointerdown", onActivity);
    return () => {
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("pointerdown", onActivity);
    };
  }, [refresh]);

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return (
    <ModalOverlay isOpen={warning && remainingMs > 0} className="modal-overlay" isKeyboardDismissDisabled>
      <Modal className="modal">
        <Dialog role="alertdialog" className="dialog">
          <Heading slot="title">You&rsquo;re about to be signed out</Heading>
          <p>
            You haven&rsquo;t been active for a while. To protect your leads, you&rsquo;ll be signed out in about two minutes. Unsaved pricing changes stay in
            this browser tab and are restored when you sign back in.
          </p>
          {/* Visual countdown only: a live region would interrupt every second. */}
          <p className="muted" aria-hidden="true">
            Time left: {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </p>
          <div className="dialog-actions">
            <Button className="btn" onPress={() => signOut("user")}>
              Sign out now
            </Button>
            <Button className="btn primary" onPress={() => void refresh()}>
              Stay signed in
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
