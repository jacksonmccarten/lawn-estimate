// Builds public/v1.js from embed/v1.js, plus a content-hashed copy under
// public/embed/ for hosts that pin a version with Subresource Integrity.
//
// LQ_WIDGET_ORIGIN is the origin of the widget app (https://w.<domain>). When
// it is unset the script uses the origin it was loaded from, which is right
// for local development and wrong for production, where v1.js is served from
// widget.<domain>.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const widgetOrigin = process.env.LQ_WIDGET_ORIGIN ?? "";
if (widgetOrigin && !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(widgetOrigin)) {
  throw new Error("LQ_WIDGET_ORIGIN must be an origin, like https://w.example.com");
}

const result = await build({
  entryPoints: [join(root, "embed/v1.js")],
  bundle: false,
  minify: true,
  target: "es2017",
  define: { __LQ_WIDGET_ORIGIN__: JSON.stringify(widgetOrigin) },
  write: false,
});
const code = result.outputFiles[0].contents;

// The design budgets about 2 KB; fail well before it could drift unnoticed.
const MAX_BYTES = 3072;
if (code.byteLength > MAX_BYTES) throw new Error(`v1.js is ${code.byteLength} bytes; the limit is ${MAX_BYTES}`);

const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
const integrity = "sha384-" + createHash("sha384").update(code).digest("base64");
const hashedName = `v1.${hash}.js`;

await rm(join(root, "public/embed"), { recursive: true, force: true });
await mkdir(join(root, "public/embed"), { recursive: true });
await writeFile(join(root, "public/v1.js"), code);
await writeFile(join(root, "public/embed", hashedName), code);
await writeFile(
  join(root, "public/embed/v1.json"),
  JSON.stringify({ file: `/embed/${hashedName}`, integrity }, null, 2) + "\n",
);

console.log(`v1.js ${code.byteLength} bytes -> /v1.js and /embed/${hashedName} (${integrity})`);
