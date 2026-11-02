import { useMemo } from "react";
import { authClient } from "./client";

export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: string | null;
  isDevFallback: boolean;
};
export type CurrentUserState = { user: AppUser | null; isPending: boolean };
export function useCurrentUserState(): CurrentUserState {
  const { data, isPending } = authClient.useSession();
  const id = data?.user.id,
    displayName = data?.user.name ?? null,
    primaryEmail = data?.user.email ?? null,
    profileImageUrl = data?.user.image ?? null;
  const user = useMemo(
    () => (id ? { id, displayName, primaryEmail, profileImageUrl, isDevFallback: false } : null),
    [id, displayName, primaryEmail, profileImageUrl],
  );
  return { user, isPending };
}
export function useCurrentUser() {
  return useCurrentUserState().user;
}
