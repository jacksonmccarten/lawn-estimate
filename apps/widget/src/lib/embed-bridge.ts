// The iframe's half of the conversation with embed/v1.js, which documents
// the messages. On the hosted page (no embedding parent) every method is a
// no-op and the embed origin is null.
//
// The handshake: this side posts a content-free lq:ready; v1.js answers
// lq:hello. The browser stamps that answer with the parent's origin, so it is
// the one report of the embedding site that the page cannot get wrong, and
// the only origin anything else is posted to.

export type Bridge = {
  embedded: boolean;
  /** Attach listeners; returns the cleanup. */
  start(companyName: string): () => void;
  /**
   * The origin of the embedding page, for the API's allowlist check: null on
   * the hosted page, the handshake's origin when there is one, otherwise what
   * the browser reports through ancestorOrigins or the referrer.
   */
  embedOrigin(): Promise<string | null>;
  submitted(): void;
};

const HANDSHAKE_WAIT_MS = 1500;

function reportedOrigin(): string | null {
  const ancestors = window.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0] ?? null;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

export function createBridge(allowedOrigins: string[]): Bridge {
  const embedded = typeof window !== "undefined" && window.parent !== window;
  let parentOrigin: string | null = null;
  let lastHeight = 0;
  const waiting: (() => void)[] = [];

  function post(message: Record<string, unknown>) {
    if (parentOrigin) window.parent.postMessage(message, parentOrigin);
  }

  function postHeight() {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    post({ type: "lq:resize", height });
  }

  return {
    embedded,

    start(companyName) {
      if (!embedded) return () => {};

      const onMessage = (event: MessageEvent) => {
        if (event.source !== window.parent) return;
        if ((event.data as { type?: unknown } | null)?.type !== "lq:hello") return;
        // frame-ancestors already keeps unlisted sites from framing the page;
        // this keeps the page from talking to one if that header is lost. With
        // no list, any site may embed it.
        if (allowedOrigins.length > 0 && event.origin !== window.location.origin && !allowedOrigins.includes(event.origin.toLowerCase())) return;
        parentOrigin = event.origin;
        waiting.splice(0).forEach((resolve) => resolve());
        post({ type: "lq:meta", name: companyName });
        lastHeight = 0;
        postHeight();
      };
      // WCAG 2.4.11: let the host scroll the focused control clear of its own sticky header.
      const onFocus = (event: FocusEvent) => {
        if (!(event.target instanceof Element)) return;
        const rect = event.target.getBoundingClientRect();
        post({ type: "lq:focus", top: rect.top, bottom: rect.bottom });
      };
      // Fires on content changes and after zoom (WCAG 1.4.4, 1.4.10).
      const observer = new ResizeObserver(postHeight);

      window.addEventListener("message", onMessage);
      document.addEventListener("focusin", onFocus);
      observer.observe(document.documentElement);
      // Says nothing, so it can go to whoever the parent is.
      window.parent.postMessage({ type: "lq:ready" }, "*");

      return () => {
        window.removeEventListener("message", onMessage);
        document.removeEventListener("focusin", onFocus);
        observer.disconnect();
      };
    },

    async embedOrigin() {
      if (!embedded) return null;
      if (parentOrigin) return parentOrigin;
      const reported = reportedOrigin();
      if (reported) return reported;
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        setTimeout(resolve, HANDSHAKE_WAIT_MS);
      });
      return parentOrigin;
    },

    submitted() {
      post({ type: "lq:submitted" });
    },
  };
}
