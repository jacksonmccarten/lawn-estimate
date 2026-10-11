// Cloudflare Turnstile, one fresh token per public call (tokens are single
// use). The script is loaded from challenges.cloudflare.com on first need.
// Turnstile shows no puzzle; in the rare interactive case its checkbox
// appears in the container this module is given (WCAG 3.3.8).

type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      execution: "execute";
      appearance: "interaction-only";
      callback(token: string): void;
      "error-callback"(): void;
      "timeout-callback"(): void;
    },
  ): string;
  execute(container: HTMLElement): void;
  reset(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** What the fixture API accepts. Never sent anywhere else: without fixtures a site key is required. */
export const FIXTURE_TOKEN = "fixture-turnstile-token";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export class TurnstileError extends Error {}

let scriptLoading: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  scriptLoading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new TurnstileError()));
    script.onerror = () => {
      scriptLoading = null;
      reject(new TurnstileError());
    };
    document.head.appendChild(script);
  });
  return scriptLoading;
}

export type Turnstile = { token(): Promise<string> };

export function createTurnstile(siteKey: string | null, container: () => HTMLElement | null): Turnstile {
  if (!siteKey) return { token: async () => FIXTURE_TOKEN };

  let widgetId: string | null = null;
  let pending: { resolve(token: string): void; reject(error: Error): void } | null = null;

  return {
    async token() {
      const api = await loadScript();
      const el = container();
      if (!el) throw new TurnstileError();
      return new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        if (widgetId === null) {
          const fail = () => pending?.reject(new TurnstileError());
          widgetId = api.render(el, {
            sitekey: siteKey,
            execution: "execute",
            appearance: "interaction-only",
            callback: (token) => pending?.resolve(token),
            "error-callback": fail,
            "timeout-callback": fail,
          });
        } else {
          api.reset(widgetId);
        }
        api.execute(el);
      });
    },
  };
}
