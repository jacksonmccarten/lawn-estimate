import { EstimateRequest } from "@lq/api-contract";
import type { NextApiRequest, NextApiResponse } from "next";
import { serverConfig } from "../../../server/config";
import { invalidRequest, replayEstimate } from "../../../server/fixtures";
import { loadProfile } from "../../../server/profile";

/** POST /api/fixtures/estimate: the recorded /estimate. Absent unless fixtures are on. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const config = serverConfig();
  if (!config.fixtures || req.method !== "POST") return res.status(404).end();
  res.setHeader("Cache-Control", "no-store");

  const parsed = EstimateRequest.safeParse(req.body);
  if (!parsed.success) {
    const reply = invalidRequest();
    return res.status(reply.httpStatus).json(reply.body);
  }
  const profile = "company" in parsed.data ? await loadProfile(parsed.data.company, config) : null;
  const reply = replayEstimate(parsed.data, profile ? profile.allowedOrigins : null);
  return res.status(reply.httpStatus).json(reply.body);
}
