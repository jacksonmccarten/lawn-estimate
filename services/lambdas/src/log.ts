// Structured logs, one JSON line each, for CloudWatch metric filters.
// Never pass an address, a phone number, an email or a name: log ids.

type Fields = Record<string, string | number | boolean | null | undefined>;

export type Log = (level: "info" | "warn" | "error", event: string, fields?: Fields) => void;

export const log: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};
