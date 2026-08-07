/**
 * Shared Fetch-shaped app path used for both live record and CLI replay.
 * The dependency base URL is taken from `x-epok-dependency-base` on the inbound
 * request so ephemeral record ports still match during injected replay.
 */
export async function handleRequest(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? "anon";
  const depBase = request.headers.get("x-epok-dependency-base");
  if (!depBase) {
    throw new Error("missing x-epok-dependency-base header");
  }
  const url = `${depBase}/quote?id=${encodeURIComponent(requestId)}`;
  const depRes = await fetch(url);
  const payload = (await depRes.json()) as { quote: number };
  return Response.json({
    requestId,
    total: payload.quote,
  });
}

export default handleRequest;
