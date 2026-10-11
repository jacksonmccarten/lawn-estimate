// The user pool's password policy (infra/lib/state-stack.ts), checked in the
// browser first so the answer is immediate. Cognito checks it again.

export const PASSWORD_HINT = "At least 12 characters, with a capital letter, a small letter and a number.";

/** What is wrong with a password, or null if it meets the policy. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) return "Include a capital letter, a small letter and a number.";
  return null;
}
