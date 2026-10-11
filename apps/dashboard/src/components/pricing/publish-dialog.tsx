"use client";

import type { PricingVersion, PricingVersionDiff } from "@lq/api-contract";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { describeError } from "@/lib/api";
import { useApi } from "../auth-provider";
import { BusyButton } from "../ui";
import { DiffView } from "./describe";

type Props = {
  version: { id: string; version: number };
  isOpen: boolean;
  onClose: () => void;
  onPublished: (version: PricingVersion) => void;
};

/**
 * Publishing in two steps (3.3.4): first the diff against the version now in
 * force, then an explicit confirmation. Nothing is sent until the second step.
 */
export function PublishDialog({ version, isOpen, onClose, onPublished }: Props) {
  const api = useApi();
  const [step, setStep] = useState<"review" | "confirm">("review");
  const [diff, setDiff] = useState<PricingVersionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setStep("review");
    setDiff(null);
    setError(null);
    api.diffPricingVersion(version.id).then(
      (result) => !cancelled && setDiff(result),
      (caught: unknown) => !cancelled && setError(describeError(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen, api, version.id]);

  // The dialog's content is replaced between steps; keep focus on its heading.
  useEffect(() => {
    if (isOpen && step === "confirm") headingRef.current?.focus();
  }, [isOpen, step]);

  async function publish() {
    setPending(true);
    setError(null);
    try {
      onPublished(await api.publishPricingVersion(version.id));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={(open) => !open && onClose()} isDismissable className="modal-overlay">
      <Modal className="modal wide">
        <Dialog className="dialog">
          {step === "review" ? (
            <>
              <Heading slot="title">Step 1 of 2: review changes in version {version.version}</Heading>
              {!diff && !error && <p role="status">Comparing with the published version&hellip;</p>}
              {diff?.identical && <p>This draft is the same as the published version, so there is nothing to publish.</p>}
              {diff && !diff.identical && (
                <>
                  <p>Compared with the version homeowners are quoted from now:</p>
                  <DiffView diff={diff} />
                </>
              )}
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <Button className="btn" onPress={onClose}>
                  {diff?.identical ? "Close" : "Cancel"}
                </Button>
                {diff && !diff.identical && (
                  <Button className="btn primary" onPress={() => setStep("confirm")}>
                    Continue
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <Heading slot="title" ref={headingRef} tabIndex={-1}>
                Step 2 of 2: publish version {version.version}?
              </Heading>
              <p>
                New quotes will use these prices as soon as you publish. Quotes already sent keep the prices they were given. A published version can&rsquo;t
                be edited; to undo this, roll back to the previous version from the Pricing page.
              </p>
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <Button className="btn" onPress={() => setStep("review")}>
                  Back to changes
                </Button>
                <BusyButton className="btn primary" onPress={publish} isBusy={pending}>
                  Publish version {version.version}
                </BusyButton>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
