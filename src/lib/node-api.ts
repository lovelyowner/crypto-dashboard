import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveDeploymentConfiguration } from "./deployment-config.js";

/** Bounds auth and profile payloads even when Vercel has already parsed JSON. */
export const MAX_API_BODY_BYTES = 128 * 1024;

export type NodeApiRequest = IncomingMessage & { body?: unknown };
export type ApiDispatcher = (request: Request) => Promise<Response>;

interface NodeApiOptions {
  /** An explicit origin is useful for isolated adapter tests and local runners. */
  baseUrl?: string;
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function configuredOrigin(options: NodeApiOptions): URL {
  const deployment = resolveDeploymentConfiguration(process.env);
  const production = deployment.production;
  // Configuration discovery must work without credentials. Never derive its
  // origin from Host or forwarded headers supplied by the caller.
  const configured = options.baseUrl ?? deployment.authOrigin;
  const url = new URL(
    configured || (production ? "https://unconfigured.invalid" : "http://localhost:8080"),
  );
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (production && url.protocol !== "https:")
  )
    throw new Error("Invalid API origin configuration");
  return new URL(url.origin);
}

function requestHeaders(request: NodeApiRequest, origin: URL): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // Cookie is a single semicolon-separated request header, unlike the
      // separate Set-Cookie fields returned by the server.
      if (name.toLowerCase() === "cookie") headers.set(name, value.join("; "));
      else for (const item of value) headers.append(name, item);
    } else headers.set(name, value);
  }
  headers.set("host", origin.host);
  headers.set("x-forwarded-host", origin.host);
  headers.set("x-forwarded-proto", origin.protocol.slice(0, -1));
  headers.delete("transfer-encoding");
  return headers;
}

async function boundedBody(request: NodeApiRequest, headers: Headers): Promise<Buffer | undefined> {
  const declaredLength = headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_API_BODY_BYTES)
  )
    throw new ApiRequestError(413, "Request body is too large.");
  if (request.method === "GET" || request.method === "HEAD") return undefined;

  if (request.body !== undefined) {
    let bytes: Buffer;
    try {
      if (Buffer.isBuffer(request.body)) bytes = request.body;
      else if (request.body instanceof Uint8Array) bytes = Buffer.from(request.body);
      else if (typeof request.body === "string") bytes = Buffer.from(request.body, "utf8");
      else {
        const json = JSON.stringify(request.body);
        if (json === undefined) throw new Error("Unserializable body");
        bytes = Buffer.from(json, "utf8");
      }
    } catch {
      throw new ApiRequestError(400, "Invalid request body.");
    }
    if (bytes.byteLength > MAX_API_BODY_BYTES)
      throw new ApiRequestError(413, "Request body is too large.");
    return bytes;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // Returning early from IncomingMessage's default iterator destroys its
    // socket, which would prevent the caller from receiving the 413 response.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_API_BODY_BYTES) throw new ApiRequestError(413, "Request body is too large.");
      chunks.push(bytes);
    }
  } catch (error) {
    request.resume(); // drain an oversized/failed upload without buffering it
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(400, "Could not read request body.");
  }
  return size ? Buffer.concat(chunks, size) : undefined;
}

async function toWebRequest(request: NodeApiRequest, options: NodeApiOptions): Promise<Request> {
  const origin = configuredOrigin(options);
  const target = request.url || "/";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\"))
    throw new ApiRequestError(400, "Invalid request URL.");
  const url = new URL(target, origin);
  if (url.origin !== origin.origin || !url.pathname.startsWith("/api/"))
    throw new ApiRequestError(404, "API route not found.");
  const headers = requestHeaders(request, origin);
  const body = await boundedBody(request, headers);
  if (body) headers.set("content-length", String(body.byteLength));
  else headers.delete("content-length");
  try {
    return new Request(url, {
      method: request.method || "GET",
      headers,
      body: body ? Uint8Array.from(body) : undefined,
    });
  } catch {
    throw new ApiRequestError(400, "Invalid API request.");
  }
}

/** Adapt Node/Vercel requests without relying on TanStack's request context. */
export function createNodeApiHandler(dispatch: ApiDispatcher, options: NodeApiOptions = {}) {
  return async (request: NodeApiRequest, response: ServerResponse): Promise<void> => {
    let result: Response;
    try {
      result = await dispatch(await toWebRequest(request, options));
    } catch (error) {
      result = Response.json(
        {
          message:
            error instanceof ApiRequestError
              ? error.message
              : "Account service is temporarily unavailable.",
        },
        { status: error instanceof ApiRequestError ? error.status : 503 },
      );
    }
    try {
      // Read before sending headers so body errors can still return a clean
      // generic failure rather than a partial account response.
      const body = request.method === "HEAD" ? undefined : Buffer.from(await result.arrayBuffer());
      response.statusCode = result.status;
      result.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
      });
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader("set-cookie", cookies);
      response.setHeader("cache-control", "private, no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.end(body);
    } catch {
      if (!response.headersSent && !response.writableEnded) {
        response.statusCode = 503;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "private, no-store");
        response.end(JSON.stringify({ message: "Account service is temporarily unavailable." }));
      } else if (!response.writableEnded) response.end();
    }
  };
}
