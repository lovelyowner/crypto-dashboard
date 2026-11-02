import { getRequest } from "@tanstack/react-start/server";
import { auth, authConfigured } from "./server";
export { authConfigured };
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
export type VerifiedUser = { id: string; email: string | null };
export async function getSessionUser(_bearerToken?: string): Promise<VerifiedUser | null> {
  if (!authConfigured) return null;
  const request = getRequest();
  if (!request) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ? { id: session.user.id, email: session.user.email ?? null } : null;
}
export async function requireUserId(_bearerToken?: string): Promise<string> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user.id;
}
