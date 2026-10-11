import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { qrModules, qrPath, qrSide, QUIET_ZONE } from "../src/lib/qr";

/** The code as a scanner's camera would see it: black on white, quiet zone included, `scale` pixels to a module. */
function picture(modules: boolean[][], scale: number): { data: Uint8ClampedArray; side: number } {
  const side = qrSide(modules) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = (((y + QUIET_ZONE) * scale + dy) * side + (x + QUIET_ZONE) * scale + dx) * 4;
          data[at] = data[at + 1] = data[at + 2] = 0;
        }
      }
    }),
  );
  return { data, side };
}

describe("the hosted page's QR code", () => {
  const link = "https://main.d6ylkt1dbfyd8.amplifyapp.com/w/nittany-lawn";

  it("scans back to the link it was made from", () => {
    const { data, side } = picture(qrModules(link), 4);
    expect(jsQR(data, side, side)?.data).toBe(link);
  });

  it("holds a long slug too", () => {
    const long = `https://w.example.test/w/${"a-very-long-company-name-".repeat(4)}lawn`;
    const { data, side } = picture(qrModules(long), 4);
    expect(jsQR(data, side, side)?.data).toBe(long);
  });

  it("is a square with a square for every dark module, inside the quiet zone", () => {
    const modules = qrModules(link);
    expect(modules.every((row) => row.length === modules.length)).toBe(true);
    expect(qrSide(modules)).toBe(modules.length + 8);
    const dark = modules.flat().filter(Boolean).length;
    const path = qrPath(modules);
    expect(path.match(/M/g)).toHaveLength(dark);
    // The finder pattern's corner is the first dark module: it sits just inside the quiet zone.
    expect(path.startsWith(`M${QUIET_ZONE} ${QUIET_ZONE}h1v1h-1z`)).toBe(true);
  });
});
