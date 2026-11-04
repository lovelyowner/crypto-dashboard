export class ContactRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ContactRequestError";
  }
}

/** Account and payment details stay in same-origin requests and ephemeral component state. */
export async function contactRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    capabilityToken?: string;
    anonymous?: boolean;
  } = {},
): Promise<unknown> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: options.anonymous || options.capabilityToken ? "omit" : "same-origin",
    cache: "no-store",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.capabilityToken ? { "X-Payment-Token": options.capabilityToken } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message.slice(0, 500)
        : "This service is unavailable. Please try again.";
    throw new ContactRequestError(message, response.status);
  }
  return data;
}

export function contactError(error: unknown): string {
  return error instanceof Error && error.name !== "AbortError"
    ? error.message
    : "The request could not be completed. Please try again.";
}
