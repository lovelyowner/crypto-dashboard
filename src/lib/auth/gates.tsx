import { useState, type ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { signOut } from "./client";
import { useCurrentUserState } from "./use-current-user";
export const SIGN_IN_PATH = "/login";
export function SignedIn({ children }: { children: ReactNode }) {
  return useCurrentUserState().user ? <>{children}</> : null;
}
export function SignedOut({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  return !isPending && !user ? <>{children}</> : null;
}
export function RedirectToSignIn() {
  return <Navigate to="/login" />;
}
export function SignInButtons() {
  return <a href="/login">Sign in to your account</a>;
}
export function SignInGate({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  return isPending ? null : user ? <>{children}</> : <>{fallback ?? <SignInButtons />}</>;
}
export function UserButton() {
  const { user, isPending } = useCurrentUserState();
  const [error, setError] = useState("");
  return (
    <>
      {isPending ? null : user ? (
        <button
          type="button"
          onClick={() => {
            void signOut().catch(() => setError("Sign-out failed. Please retry."));
          }}
        >
          Sign out {user.displayName}
        </button>
      ) : (
        <a href="/login">Sign in</a>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
