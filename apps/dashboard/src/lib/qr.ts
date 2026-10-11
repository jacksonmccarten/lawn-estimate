// A QR code for a link, as a grid of modules to draw. Made in the browser:
// the link is not sent anywhere to be turned into a picture.

import qrcode from "qrcode-generator";

/** Blank modules a scanner needs around the code on every side. */
export const QUIET_ZONE = 4;

/**
 * The code as rows of modules, true where one is dark. Error correction is
 * medium (about 15% of the code can be damaged or dirty and it still scans),
 * which suits something printed on a truck or a yard sign.
 */
export function qrModules(text: string): boolean[][] {
  // 0: the smallest version that holds the text.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => qr.isDark(row, column)));
}

/** The side of the whole picture, in modules, quiet zone included. */
export const qrSide = (modules: boolean[][]) => modules.length + 2 * QUIET_ZONE;

/** The dark modules as one SVG path, in module units, offset by the quiet zone. */
export function qrPath(modules: boolean[][]): string {
  let path = "";
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }),
  );
  return path;
}
