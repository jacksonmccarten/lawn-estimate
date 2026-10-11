import { Regions, ZipsNear, errorResponse, type ServiceRegion } from "@lq/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeMockToken } from "@/lib/auth/mock-token";
import { addArea, describeArea, groupName, removeArea, toAreas, toRegions } from "@/lib/service-area";
import { handleMockRequest } from "@/mock/handlers";
import { MOCK_OWNER_SUB, resetStore } from "@/mock/store";

const county = (value: string, tierGroup = "standard"): ServiceRegion => ({ kind: "county", value, tierGroup });
const zip = (value: string, tierGroup: string): ServiceRegion => ({ kind: "zip", value, tierGroup });

describe("service areas as the screen shows them", () => {
  const stored = [county("Centre"), county("Blair"), zip("16803", "near-shop"), zip("16801", "near-shop"), zip("15217", "city")];

  it("reads one area for each region group, and writes the same regions back", () => {
    const areas = toAreas(stored);
    expect(areas).toEqual([
      { group: "standard", counties: ["Blair", "Centre"], zips: [] },
      { group: "near-shop", counties: [], zips: ["16801", "16803"] },
      { group: "city", counties: [], zips: ["15217"] },
    ]);
    const back = toRegions(areas);
    expect(Regions.safeParse({ regions: back }).success).toBe(true);
    expect(new Set(back.map((r) => `${r.kind}:${r.value}:${r.tierGroup}`))).toEqual(new Set(stored.map((r) => `${r.kind}:${r.value}:${r.tierGroup}`)));
  });

  it("says what an area covers", () => {
    const [standard, nearShop, city] = toAreas(stored);
    expect(describeArea(standard!, 67)).toBe("2 counties");
    expect(describeArea(nearShop!, 67)).toBe("2 zip codes");
    expect(describeArea(city!, 67)).toBe("1 zip code");
    // A new company's one area: every county in the state.
    expect(describeArea({ group: "standard", counties: Array.from({ length: 67 }, (_, i) => `c${i}`), zips: [] }, 67)).toBe("all of Pennsylvania");
    expect(describeArea({ group: "mixed", counties: ["Centre"], zips: ["16801"] }, 67)).toBe("1 county and 1 zip code");
  });

  it("makes a region group out of an area's name", () => {
    expect(groupName("  Near the Shop! ")).toBe("near-the-shop");
    expect(groupName("State College & Boalsburg (15 mi)")).toBe("state-college-boalsburg-15-mi");
    expect(groupName("x".repeat(60))).toHaveLength(40);
    expect(groupName("!!!")).toBe("");
  });

  it("adds an area of zip codes, leaving a zip code in the area that already has it", () => {
    const areas = toAreas(stored);
    const result = addArea(areas, "east", ["16827", "16801", "16827"]);
    expect(result).toMatchObject({ added: 1, skipped: 2 });
    expect(result.areas.at(-1)).toEqual({ group: "east", counties: [], zips: ["16827"] });
    // Nothing new: no area is added at all.
    expect(addArea(areas, "dup", ["16801", "16803"])).toMatchObject({ added: 0, areas });
  });

  it("removes an area by its group, counties and zip codes alike", () => {
    const areas = toAreas(stored);
    expect(removeArea(areas, "standard").map((a) => a.group)).toEqual(["near-shop", "city"]);
    expect(toRegions(removeArea(areas, "near-shop")).some((r) => r.tierGroup === "near-shop")).toBe(false);
    expect(removeArea(areas, "no-such-area")).toEqual(areas);
  });
});

describe("the mock's zips-near route", () => {
  const token = `Bearer ${encodeMockToken({ sub: MOCK_OWNER_SUB, email: "o@example.com", "cognito:groups": ["owner"], exp: Date.now() / 1000 + 600 })}`;
  const near = (query: string) => handleMockRequest({ method: "GET", path: "/zips-near", query: new URLSearchParams(query), authorization: token, body: undefined });

  beforeEach(resetStore);

  it("lists the zip codes within the distance, nearest first, the centre first of all", () => {
    const five = near("zip=16801&miles=5");
    expect(five.status).toBe(200);
    expect(ZipsNear.parse(five.body)).toEqual({ zip: "16801", miles: 5, zips: ["16801", "16803", "16827"] });
    expect(ZipsNear.parse(near("zip=16801&miles=15").body).zips).toEqual(["16801", "16803", "16827", "16823", "16870"]);
    expect(ZipsNear.parse(near("zip=16801&miles=1").body).zips).toEqual(["16801"]);
  });

  it("refuses a zip code it has no location for, and a distance out of range", () => {
    for (const query of ["zip=00000&miles=5", "zip=16801&miles=0", "zip=16801&miles=101", "zip=1680&miles=5", "miles=5"]) {
      const response = near(query);
      expect([query, response.status, errorResponse.parse(response.body).error.code]).toEqual([query, 400, "invalid_request"]);
    }
  });
});
