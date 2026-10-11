// Serves the mock company-api at /mock-api/* when the app is built or run with
// the mock on. In any other build every path here answers 404.

import { handleMockRequest } from "@/mock/handlers";
import { resetStore } from "@/mock/store";

export const dynamic = "force-dynamic";

const enabled = process.env.NEXT_PUBLIC_LQ_MOCK === "1";

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  if (!enabled) return new Response(null, { status: 404 });
  const path = `/${(await context.params).path.join("/")}`;
  const headers = { "Cache-Control": "no-store" };

  // For the Playwright suite: back to the seeded company.
  if (path === "/__reset" && request.method === "POST") {
    resetStore();
    return new Response(null, { status: 204, headers });
  }

  let body: unknown = undefined;
  if (request.method !== "GET") {
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
  }
  const result = handleMockRequest({
    method: request.method,
    path,
    query: new URL(request.url).searchParams,
    authorization: request.headers.get("authorization"),
    body,
  });
  return Response.json(result.body, { status: result.status, headers });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH };
