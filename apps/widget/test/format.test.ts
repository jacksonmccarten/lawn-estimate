import { describe, expect, it } from "vitest";
import { formatAddress, formatBps, formatCents, formatSqft, telHref } from "../src/lib/format";

describe("format", () => {
  it("formats integer cents without floating-point arithmetic", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(5088)).toBe("$50.88");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  it("formats basis points as a percentage", () => {
    expect(formatBps(600)).toBe("6%");
    expect(formatBps(700)).toBe("7%");
    expect(formatBps(625)).toBe("6.25%");
    expect(formatBps(0)).toBe("0%");
  });

  it("formats areas", () => {
    expect(formatSqft(8400)).toBe("8,400 sq ft");
  });

  it("builds a tel: link only from something diallable", () => {
    expect(telHref("(717) 555-0142")).toBe("tel:7175550142");
    expect(telHref("+1 717-555-0142")).toBe("tel:+17175550142");
    expect(telHref("call us")).toBeNull();
  });

  it("writes the four address boxes as one line, the way an envelope is addressed", () => {
    expect(formatAddress({ street: "412 Maple Ave", city: "Lancaster", state: "PA", zip: "17601" })).toBe("412 Maple Ave, Lancaster, PA 17601");
    // Stray spaces go, and the state is upper case.
    expect(formatAddress({ street: "  412   Maple Ave ", city: " Lancaster ", state: " pa ", zip: " 17601 " })).toBe("412 Maple Ave, Lancaster, PA 17601");
  });
});
