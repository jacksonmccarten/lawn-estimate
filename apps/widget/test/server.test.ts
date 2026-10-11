import { describe, expect, it } from "vitest";
import { serverConfig } from "../src/server/config";
import { buildCsp, frameAncestors } from "../src/server/csp";
import { loadProfile, sanitizeProfile, type RawProfile } from "../src/server/profile";

const base = { apiOrigin: null, logoOrigin: null, turnstile: false, mapbox: false, dev: false };

function directive(csp: string, name: string): string | undefined {
  return csp.split("; ").find((d) => d === name || d.startsWith(name + " "));
}

describe("frame-ancestors", () => {
  it("lets any site embed the widget when the company lists none", () => {
    expect(frameAncestors([])).toBe("frame-ancestors *");
  });

  it("is 'self' alone for an unknown company", () => {
    expect(frameAncestors(null)).toBe("frame-ancestors 'self'");
  });

  it("lists the company's origins", () => {
    expect(frameAncestors(["https://joeslawn.com", "https://www.joeslawn.com"])).toBe(
      "frame-ancestors 'self' https://joeslawn.com https://www.joeslawn.com",
    );
  });

  it("drops anything that is not a bare origin, so nothing can add a source or a directive", () => {
    expect(
      frameAncestors([
        "https://ok.example",
        "*",
        "https://*.example.com",
        "https://a.example; script-src *",
        "https://a.example https://evil.example",
        "https://a.example/path",
        "https://a.example\r\nX-Injected: 1",
        "javascript:alert(1)",
        "",
      ]),
    ).toBe("frame-ancestors 'self' https://ok.example");
  });

  it("lower-cases and de-duplicates", () => {
    expect(frameAncestors(["https://Joes.Example", "https://joes.example"])).toBe("frame-ancestors 'self' https://joes.example");
  });
});

describe("buildCsp", () => {
  it("allows no inline or evaluated script in production", () => {
    const csp = buildCsp({ ...base, allowedOrigins: [] });
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(directive(csp, "style-src")).toBe("style-src 'self'");
    expect(directive(csp, "default-src")).toBe("default-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
    expect(directive(csp, "frame-src")).toBe("frame-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("admits Turnstile, the API and the logo CDN by exact origin", () => {
    const csp = buildCsp({
      allowedOrigins: [],
      apiOrigin: "https://api.example.com",
      logoOrigin: "https://assets.example.com",
      turnstile: true,
      mapbox: false,
      dev: false,
    });
    expect(directive(csp, "script-src")).toBe("script-src 'self' https://challenges.cloudflare.com");
    expect(directive(csp, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' https://api.example.com");
    expect(directive(csp, "img-src")).toBe("img-src 'self' https://assets.example.com");
  });

  it("admits Mapbox for the address lookup and the photo, and none of its script", () => {
    const csp = buildCsp({ ...base, allowedOrigins: [], mapbox: true });
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' https://api.mapbox.com");
    expect(directive(csp, "img-src")).toBe("img-src 'self' https://api.mapbox.com");
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(buildCsp({ ...base, allowedOrigins: [] })).not.toContain("mapbox");
  });

  it("ends with the company's frame-ancestors", () => {
    expect(buildCsp({ ...base, allowedOrigins: ["https://joeslawn.com"] })).toMatch(/; frame-ancestors 'self' https:\/\/joeslawn\.com$/);
  });
});

describe("sanitizeProfile", () => {
  const raw: RawProfile = {
    slug: "joes-lawn",
    name: "Joe's <b>Lawn</b>",
    theme: { color: "#1F6F43", logoKey: "logos/joes-lawn/logo.png" },
    services: [{ code: "mow", name: "Mowing", season: "growing" }],
    allowedOrigins: ["https://JoesLawn.example", "https://joeslawn.example", "not an origin"],
  };

  it("keeps a valid theme, building the logo URL under our own CDN", () => {
    const profile = sanitizeProfile(raw, "https://assets.example.com");
    expect(profile.color).toBe("#1f6f43");
    expect(profile.logoUrl).toBe("https://assets.example.com/logos/joes-lawn/logo.png");
    expect(profile.allowedOrigins).toEqual(["https://joeslawn.example"]);
    // Left as text; React escapes it wherever it is rendered.
    expect(profile.name).toBe("Joe's <b>Lawn</b>");
  });

  it("drops a color or logo that is not exactly the expected shape", () => {
    for (const theme of [
      { color: "red", logoKey: "https://evil.example/x.png" },
      { color: "#1f6f43;}body{display:none", logoKey: "logos/../secrets.png" },
      { color: 7, logoKey: "logos/x.svg" },
      null,
      "nonsense",
    ]) {
      const profile = sanitizeProfile({ ...raw, theme }, "https://assets.example.com");
      expect(profile.color).toBeNull();
      expect(profile.logoUrl).toBeNull();
    }
  });

  it("shows no logo when no logo CDN is configured", () => {
    expect(sanitizeProfile(raw, null).logoUrl).toBeNull();
  });
});

describe("serverConfig", () => {
  it("defaults to fixtures in development and never in production", () => {
    expect(serverConfig({ NODE_ENV: "development" }).fixtures).toBe(true);
    expect(serverConfig({ NODE_ENV: "development", LQ_FIXTURES: "0", LQ_API_BASE: "https://api.example.com", LQ_TURNSTILE_SITE_KEY: "k" }).fixtures).toBe(false);
    expect(() => serverConfig({ NODE_ENV: "production" })).toThrow(/LQ_API_BASE/);
  });

  it("requires an API address and a Turnstile site key without fixtures", () => {
    expect(() => serverConfig({ NODE_ENV: "production", LQ_API_BASE: "https://api.example.com" })).toThrow(/LQ_TURNSTILE_SITE_KEY/);
    const config = serverConfig({ NODE_ENV: "production", LQ_API_BASE: "https://api.example.com/v1/", LQ_TURNSTILE_SITE_KEY: "k" });
    expect(config).toMatchObject({ apiBase: "https://api.example.com/v1", apiOrigin: "https://api.example.com" });
  });

  it("takes a Mapbox public token and refuses any other kind", () => {
    const env = { NODE_ENV: "production", LQ_FIXTURES: "1" };
    expect(serverConfig(env).mapboxToken).toBeNull();
    expect(serverConfig({ ...env, NEXT_PUBLIC_MAPBOX_TOKEN: "pk.test" }).mapboxToken).toBe("pk.test");
    expect(() => serverConfig({ ...env, NEXT_PUBLIC_MAPBOX_TOKEN: "sk.secret" })).toThrow(/public token/);
  });

  it("serves the fixture API from this app when fixtures are on", () => {
    const config = serverConfig({ NODE_ENV: "production", LQ_FIXTURES: "1" });
    expect(config).toMatchObject({ apiBase: "/api/fixtures", apiOrigin: null, turnstileSiteKey: null });
  });
});

describe("loadProfile", () => {
  const config = serverConfig({ NODE_ENV: "production", LQ_FIXTURES: "1" });

  it("finds a fixture company and nothing else", async () => {
    expect((await loadProfile("joes-lawn", config))?.name).toBe("Joe's Lawn Care");
    expect(await loadProfile("no-such-company", config)).toBeNull();
    expect(await loadProfile("../etc/passwd", config)).toBeNull();
  });

  describe("without fixtures", () => {
    const live = serverConfig({ NODE_ENV: "production", LQ_API_BASE: "https://api.example.com", LQ_TURNSTILE_SITE_KEY: "k" });
    const body = {
      slug: "joes-lawn",
      name: "Joe's Lawn Care",
      theme: { color: "#1B5E20" },
      services: [{ code: "mow", name: "Mowing", season: "growing" }],
      allowedOrigins: ["https://JoesLawn.example"],
    };
    const answering = (status: number, json: unknown) => {
      const calls: string[] = [];
      const doFetch = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify(json), { status });
      }) as typeof fetch;
      return { calls, doFetch };
    };

    it("reads the profile route of the API and sanitizes what it returns", async () => {
      const { calls, doFetch } = answering(200, body);
      expect(await loadProfile("joes-lawn", live, doFetch)).toEqual({
        slug: "joes-lawn",
        name: "Joe's Lawn Care",
        services: [{ code: "mow", name: "Mowing" }],
        color: "#1b5e20",
        logoUrl: null,
        allowedOrigins: ["https://joeslawn.example"],
      });
      expect(calls).toEqual(["https://api.example.com/profile/joes-lawn"]);
    });

    it("is null on a 404 and never asks about a malformed slug", async () => {
      const { calls, doFetch } = answering(404, { error: { code: "not_found", message: "no such company" } });
      expect(await loadProfile("no-such-company", live, doFetch)).toBeNull();
      expect(await loadProfile("../etc/passwd", live, doFetch)).toBeNull();
      expect(calls).toHaveLength(1);
    });

    it("throws on a failing API or a body that is not the contract's", async () => {
      await expect(loadProfile("joes-lawn", live, answering(500, {}).doFetch)).rejects.toThrow(/500/);
      await expect(loadProfile("joes-lawn", live, answering(200, { ...body, rates: [1] }).doFetch)).rejects.toThrow();
    });
  });
});
