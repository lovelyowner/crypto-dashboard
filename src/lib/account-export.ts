import { validateCreatorProfile } from "./creator-profile";
import { isFreshAccountSession } from "./auth/policy";

type Session = {
  user: {
    id: string;
    name?: string | null;
    email?: string;
    emailVerified?: boolean;
    username?: unknown;
  };
  session: { userId: string; expiresAt: Date | string; createdAt: Date | string };
};
export type AccountExportSource = {
  identities: Record<string, unknown>[];
  draft: { profile: unknown; updatedAt: Date | string } | null;
  publication: {
    handle: string;
    profile: unknown;
    published: boolean;
    updatedAt: Date | string;
  } | null;
};
type Dependencies = {
  configured: boolean;
  getSession: (headers: Headers) => Promise<Session | null>;
  read: (userId: string) => Promise<AccountExportSource>;
  now?: () => number;
};
const iso = (value: unknown) =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && !/\p{Cc}/u.test(value) ? value : null;

export function createAccountExportHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    const error = (message: string, status: number) =>
      Response.json({ message }, { status, headers });
    if (request.method !== "GET") return error("Method not allowed.", 405);
    if (!deps.configured) return error("Account export is not configured.", 503);
    try {
      const session = await deps.getSession(request.headers);
      const now = deps.now?.() ?? Date.now();
      if (
        !session ||
        !session.user.id ||
        session.user.id !== session.session.userId ||
        new Date(session.session.expiresAt).getTime() <= now ||
        !Number.isFinite(new Date(session.session.expiresAt).getTime())
      )
        return error("Sign in to export your account data.", 401);
      if (!isFreshAccountSession(session.session.createdAt, now))
        return error("Sign in again to download your account data.", 403);
      const source = await deps.read(session.user.id);
      const identities = source.identities
        .slice(0, 50)
        .filter((row) => row.providerId !== "credential")
        .map((row) => {
          const providerId = text(row.providerId, 64),
            accountId = text(row.accountId, 256);
          if (!providerId || !accountId) throw new Error("Invalid identity record");
          return { providerId, accountId };
        });
      const payload = {
        version: 1,
        exportedAt: new Date(now).toISOString(),
        scope: "account-profile",
        complete: false,
        account: {
          id: session.user.id,
          name: text(session.user.name, 300),
          email: text(session.user.email, 320),
          emailVerified: session.user.emailVerified === true,
          username: text(session.user.username, 160),
        },
        linkedProviders: { items: identities, limit: 50, complete: source.identities.length <= 50 },
        profileDraft: source.draft
          ? {
              profile: validateCreatorProfile(source.draft.profile),
              updatedAt: iso(source.draft.updatedAt),
            }
          : null,
        publishedProfile: source.publication
          ? {
              handle: source.publication.handle,
              profile: validateCreatorProfile(source.publication.profile),
              published: source.publication.published === true,
              updatedAt: iso(source.publication.updatedAt),
            }
          : null,
        omitted: [
          "Conversations and replies",
          "Payments",
          "Moderation and authentication secrets",
          "Browser-local wallets and watchlists",
        ],
      };
      const body = JSON.stringify(payload);
      if (new TextEncoder().encode(body).length > 262_144)
        return error("This export is too large. Contact the website owner.", 413);
      return new Response(body, {
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="fathom-account-profile-${new Date(now).toISOString().slice(0, 10)}.json"`,
        },
      });
    } catch {
      return error("Could not export account data. Try again.", 503);
    }
  };
}
