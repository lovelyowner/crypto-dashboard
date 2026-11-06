export type AuthRequestDiagnostic = {
  status: number;
  responseType: string;
  requestId?: string;
};

/** Public response metadata only; never read the body, cookies, or URL/query. */
export function readAuthRequestDiagnostic(response: Response): AuthRequestDiagnostic {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const requestId = response.headers.get("x-vercel-id");
  return {
    status: response.status,
    responseType:
      type && type.length <= 100 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
        ? type
        : "unknown",
    ...(requestId && requestId.length <= 160 && /^[a-zA-Z0-9_.:-]+$/.test(requestId)
      ? { requestId }
      : {}),
  };
}
