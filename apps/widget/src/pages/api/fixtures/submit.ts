import { SubmitRequest } from "@lq/api-contract";
import type { NextApiRequest, NextApiResponse } from "next";
import { serverConfig } from "../../../server/config";
import { invalidRequest, replaySubmit } from "../../../server/fixtures";

/** POST /api/fixtures/submit: the recorded /submit. Absent unless fixtures are on. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!serverConfig().fixtures || req.method !== "POST") return res.status(404).end();
  res.setHeader("Cache-Control", "no-store");

  const parsed = SubmitRequest.safeParse(req.body);
  const reply = parsed.success ? replaySubmit(parsed.data) : invalidRequest();
  return res.status(reply.httpStatus).json(reply.body);
}
