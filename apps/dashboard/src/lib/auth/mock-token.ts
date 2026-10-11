// The mock sign-in's token: the claims a Cognito ID token would carry, with no
// signature. Only the mock company-api accepts it, and neither exists in a
// deployed build.

export type MockClaims = {
  sub: string;
  email: string;
  "cognito:groups": string[];
  /** Seconds since the epoch, as in a JWT. */
  exp: number;
};

const PREFIX = "mock.";

export function encodeMockToken(claims: MockClaims): string {
  return PREFIX + btoa(JSON.stringify(claims));
}

export function decodeMockToken(token: string): MockClaims | null {
  if (!token.startsWith(PREFIX)) return null;
  try {
    const claims = JSON.parse(atob(token.slice(PREFIX.length))) as Partial<MockClaims>;
    if (typeof claims.sub !== "string" || typeof claims.email !== "string" || typeof claims.exp !== "number") return null;
    return { sub: claims.sub, email: claims.email, "cognito:groups": claims["cognito:groups"] ?? [], exp: claims.exp };
  } catch {
    return null;
  }
}
