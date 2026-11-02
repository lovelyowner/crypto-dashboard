export function useCurrentUserState() {
  return { user: null, isPending: false } as {
    user: { displayName: string | null } | null;
    isPending: boolean;
  };
}
export function useCurrentUser() {
  return null;
}
