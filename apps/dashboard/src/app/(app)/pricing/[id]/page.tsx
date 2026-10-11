"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-aria-components";
import { useApi } from "@/components/auth-provider";
import { VersionContent } from "@/components/pricing/describe";
import { PricingEditor } from "@/components/pricing/editor";
import { PreviewQuote } from "@/components/pricing/preview";
import { BusyButton, LoadError, Loading, PageHeading, useToast } from "@/components/ui";
import { describeError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useLoad } from "@/lib/use-load";

function Version() {
  const { id } = useParams<{ id: string }>();
  const reviewOnOpen = useSearchParams().get("review") === "1";
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { state, reload, set } = useLoad(() => api.getPricingVersion(id), [api, id]);
  const [notice, setNotice] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const version = state.status === "ready" ? state.data : null;

  // Publishing replaces the editor with the read-only view; put focus on the result.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  async function newDraft() {
    setCopying(true);
    setCopyError(null);
    try {
      const draft = await api.createPricingVersion({ copyFrom: id });
      router.push(`/pricing/${draft.id}`);
    } catch (error) {
      setCopyError(describeError(error));
      setCopying(false);
    }
  }

  const title = version ? `Version ${version.version}${version.publishedAt ? "" : ", draft"}` : "Pricing version";
  return (
    <>
      <PageHeading title={title}>
        <Link className="link" href="/pricing">
          Back to all versions
        </Link>
      </PageHeading>
      {state.status === "loading" && <Loading what="pricing version" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {notice && (
        <p ref={noticeRef} tabIndex={-1} role="status" className="notice">
          {notice}
        </p>
      )}
      {version && version.publishedAt === null && (
        <PricingEditor
          key={version.id}
          version={version}
          reviewOnOpen={reviewOnOpen}
          onSaved={set}
          onPublished={(published) => {
            set(published);
            toast(`Version ${published.version} published.`);
            setNotice(`Version ${published.version} is published. New quotes use it from now on.`);
          }}
        />
      )}
      {version && version.publishedAt !== null && (
        <div className="stack">
          <section className="card" aria-labelledby="published-heading">
            <h2 id="published-heading">Published prices</h2>
            <p className="muted">
              Published <time dateTime={version.publishedAt}>{formatDateTime(version.publishedAt)}</time>. A published version can&rsquo;t be edited; quotes
              priced with it keep these prices.
            </p>
            <div className="form-actions">
              <BusyButton className="btn" onPress={() => void newDraft()} isBusy={copying}>
                New draft from version {version.version}
              </BusyButton>
            </div>
            {copyError && (
              <p role="alert" className="inline-error">
                {copyError}
              </p>
            )}
            <VersionContent content={version.content} />
          </section>
          <PreviewQuote versionId={version.id} content={version.content} />
        </div>
      )}
    </>
  );
}

export default function PricingVersionPage() {
  return (
    <Suspense>
      <Version />
    </Suspense>
  );
}
