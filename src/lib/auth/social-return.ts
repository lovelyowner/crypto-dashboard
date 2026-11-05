import { safeAccountReturnPath } from "./return-to";

/** Query text is untrusted. Never echo provider error descriptions or arbitrary URLs. */
export function socialReturnError(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value === "access_denied" || value === "user_cancelled")
    return "Social sign-in was cancelled. You can try again or use another sign-in method.";
  if (value === "account_not_linked" || value === "account_already_linked_to_different_user")
    return "Sign in with your existing method, then connect this service in Account & security.";
  if (value === "email_doesn't_match" || value === "email_mismatch")
    return "This service uses a different email. Use a matching verified email to connect it.";
  if (value === "email_not_found")
    return "This service did not provide an email address. Try another sign-in method.";
  return "Social sign-in could not be completed. Try again or use another sign-in method.";
}

export function socialReturnPath(next: unknown): string {
  const path = safeAccountReturnPath(next);
  return path ? `/login?next=${encodeURIComponent(path)}` : "/login";
}
