"use client";

import type { PricingVersionSummary } from "@lq/api-contract";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Link } from "react-aria-components";
import { useApi } from "@/components/auth-provider";
import { BusyButton, ConfirmDialog, LoadError, Loading, PageHeading, StatusChip, TableScroll } from "@/components/ui";
import { describeError } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { useLoad } from "@/lib/use-load";

/** The version quotes are priced from: the one published most recently. */
function currentOf(versions: PricingVersionSummary[]): PricingVersionSummary | null {
  return (
    versions
      .filter((v) => v.publishedAt !== null)
      .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))[0] ?? null
  );
}

export default function PricingPage() {
  const api = useApi();
  const router = useRouter();
  const { state, reload } = useLoad(() => api.listPricingVersions(), [api]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollback, setRollback] = useState<PricingVersionSummary | null>(null);

  const versions = state.status === "ready" ? state.data.versions : [];
  const current = currentOf(versions);

  async function createDraft(copyFrom: string | undefined, review: boolean) {
    setCreating(true);
    setError(null);
    try {
      const draft = await api.createPricingVersion(copyFrom ? { copyFrom } : {});
      router.push(`/pricing/${draft.id}${review ? "?review=1" : ""}`);
    } catch (caught) {
      setError(describeError(caught));
      setCreating(false);
    }
  }

  return (
    <>
      <PageHeading title="Pricing" />
      <p className="muted lead">
        Homeowners are quoted from the current version. To change prices, edit a draft and publish it; quotes already sent keep the version they were priced
        with.
      </p>
      {state.status === "loading" && <Loading what="pricing versions" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {state.status === "ready" && (
        <>
          <div className="form-actions">
            <BusyButton className="btn primary" onPress={() => void createDraft(current?.id, false)} isBusy={creating && !rollback}>
              {current ? `New draft from version ${current.version}` : "Start your first pricing version"}
            </BusyButton>
          </div>
          {error && !rollback && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          {versions.length === 0 ? (
            <p>No pricing yet. Until a version is published, homeowners can&rsquo;t get a price.</p>
          ) : (
            <TableScroll label="Pricing versions table">
              <table className="table">
                <caption>Pricing versions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created</th>
                    <th scope="col">Published</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => {
                    const kind = v.publishedAt === null ? "draft" : v.id === current?.id ? "current" : "previous";
                    return (
                      <tr key={v.id}>
                        <th scope="row">Version {v.version}</th>
                        <td>
                          <StatusChip kind={kind} />
                        </td>
                        <td>
                          <time dateTime={v.createdAt}>{formatDate(v.createdAt)}</time>
                        </td>
                        <td>{v.publishedAt ? <time dateTime={v.publishedAt}>{formatDateTime(v.publishedAt)}</time> : "Not published"}</td>
                        <td>
                          <div className="row-actions">
                            <Link className="link" href={`/pricing/${v.id}`} aria-label={`${kind === "draft" ? "Edit" : "View"} version ${v.version}`}>
                              {kind === "draft" ? "Edit" : "View"}
                            </Link>
                            {kind === "previous" && (
                              <Button
                                className="btn quiet"
                                onPress={() => {
                                  setError(null);
                                  setRollback(v);
                                }}
                              >
                                Roll back to version {v.version}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          )}
        </>
      )}
      <ConfirmDialog
        isOpen={rollback !== null}
        onClose={() => {
          setRollback(null);
          setCreating(false);
        }}
        title={`Roll back to version ${rollback?.version ?? ""}?`}
        confirmLabel="Continue to review"
        onConfirm={() => rollback && void createDraft(rollback.id, true)}
        isPending={creating}
        error={error}
      >
        <p>
          Published versions are never changed, so rolling back makes a new draft with version {rollback?.version}&rsquo;s prices. Next you&rsquo;ll see how it
          differs from the current version, and nothing changes for homeowners until you publish it there.
        </p>
      </ConfirmDialog>
    </>
  );
}
