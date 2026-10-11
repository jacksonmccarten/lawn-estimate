// Design tokens. Every color in the dashboard comes from here, and
// test/tokens.test.ts fails the build if a pairing below drops under its
// WCAG ratio in either scheme.

export type Scheme = Record<
  | "bg" | "surface" | "sunken" | "text" | "muted" | "border" | "control-border"
  | "accent" | "on-accent" | "link" | "focus" | "danger" | "danger-bg"
  | "chip-new-bg" | "chip-new-text" | "chip-ok-bg" | "chip-ok-text"
  | "chip-no-bg" | "chip-no-text" | "chip-old-bg" | "chip-old-text"
  | "added-bg" | "removed-bg",
  string
>;

export const light: Scheme = {
  bg: "#f5f6f4",
  surface: "#ffffff",
  sunken: "#eef0ed",
  text: "#1a1f1c",
  muted: "#525c56",
  border: "#d5dad6",
  "control-border": "#7b857f",
  accent: "#1f6b3a",
  "on-accent": "#ffffff",
  link: "#1a5e33",
  focus: "#1a4fd6",
  danger: "#a8201a",
  "danger-bg": "#fdecea",
  "chip-new-bg": "#e3ecfb",
  "chip-new-text": "#173f8a",
  "chip-ok-bg": "#e0f2e5",
  "chip-ok-text": "#14532d",
  "chip-no-bg": "#f6e4e3",
  "chip-no-text": "#7a1c1c",
  "chip-old-bg": "#e9ebe9",
  "chip-old-text": "#414843",
  "added-bg": "#e0f2e5",
  "removed-bg": "#f6e4e3",
};

export const dark: Scheme = {
  bg: "#121513",
  surface: "#1b201d",
  sunken: "#151916",
  text: "#e8ece9",
  muted: "#a9b3ad",
  border: "#343c37",
  "control-border": "#8a958f",
  accent: "#7fd69b",
  "on-accent": "#0c1f13",
  link: "#8fdda8",
  focus: "#9bb8ff",
  danger: "#ff9c94",
  "danger-bg": "#3a1917",
  "chip-new-bg": "#1c2f57",
  "chip-new-text": "#c9dafc",
  "chip-ok-bg": "#173b24",
  "chip-ok-text": "#bfeccb",
  "chip-no-bg": "#48201f",
  "chip-no-text": "#f6c9c6",
  "chip-old-bg": "#2f3531",
  "chip-old-text": "#d3d9d5",
  "added-bg": "#173b24",
  "removed-bg": "#48201f",
};

type Token = keyof Scheme;

/** [foreground, background, minimum ratio]. 4.5 for text (1.4.3), 3 for control boundaries and focus (1.4.11). */
export const pairings: ReadonlyArray<readonly [Token, Token, number]> = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["text", "sunken", 4.5],
  ["muted", "bg", 4.5],
  ["muted", "surface", 4.5],
  ["muted", "sunken", 4.5],
  ["link", "bg", 4.5],
  ["link", "surface", 4.5],
  ["link", "sunken", 4.5],
  ["on-accent", "accent", 4.5],
  ["accent", "surface", 3],
  ["danger", "surface", 4.5],
  ["danger", "danger-bg", 4.5],
  ["text", "danger-bg", 4.5],
  ["control-border", "surface", 3],
  ["control-border", "bg", 3],
  ["focus", "surface", 3],
  ["focus", "bg", 3],
  ["chip-new-text", "chip-new-bg", 4.5],
  ["chip-ok-text", "chip-ok-bg", 4.5],
  ["chip-no-text", "chip-no-bg", 4.5],
  ["chip-old-text", "chip-old-bg", 4.5],
  ["text", "added-bg", 4.5],
  ["text", "removed-bg", 4.5],
];

const declarations = (scheme: Scheme) =>
  Object.entries(scheme)
    .map(([name, value]) => `--${name}:${value};`)
    .join("");

export const tokenCss = `:root{color-scheme:light dark;${declarations(light)}}@media (prefers-color-scheme:dark){:root{${declarations(dark)}}}`;
