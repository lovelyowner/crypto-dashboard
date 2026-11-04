import { useCallback, useState } from "react";
import { CreatorProfile } from "./creator-profile";
import { ProfilePublication } from "./profile-publication";
import { ProfileContactSettings } from "./profile-contact-settings";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { validateCreatorProfile, type CreatorProfileData } from "@/lib/creator-profile";

async function accountProfile(method: "GET" | "PUT", profile?: CreatorProfileData) {
  const response = await fetch("/api/profile", {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
    ...(method === "PUT" ? { body: JSON.stringify({ profile }) } : {}),
  });
  let data: { profile?: unknown; message?: string };
  try {
    data = await response.json();
  } catch {
    throw new Error("Account storage is unavailable. Your local draft is still available.");
  }
  if (!response.ok)
    throw new Error(data.message || "Account profile could not be saved or loaded.");
  if (data.profile === null) return null;
  return validateCreatorProfile(data.profile);
}

export function AccountCreatorProfile({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { user, isPending } = useCurrentUserState();
  const [publicationRevision, setPublicationRevision] = useState(0);
  const refreshPublishedWallets = useCallback(() => {
    setPublicationRevision((value) => value + 1);
  }, []);
  return (
    <>
      {!user && (
        <div className="notice">
          <span>Your profile works locally. Sign in to save a private copy to your account.</span>{" "}
          <button type="button" className="text-button" onClick={onOpenAccount}>
            Account &amp; security
          </button>
        </div>
      )}
      <CreatorProfile
        renderPublication={(profile) => (
          <>
            <ProfilePublication
              profile={profile}
              accountAvailable={Boolean(user)}
              accountKey={user?.id ?? null}
              onPublicationChange={refreshPublishedWallets}
            />
            <ProfileContactSettings
              accountAvailable={Boolean(user)}
              accountKey={user?.id ?? null}
              publicationRevision={publicationRevision}
            />
          </>
        )}
        accountAvailable={Boolean(user)}
        accountStatus={
          isPending
            ? "Checking account…"
            : user
              ? "Private account storage is available. Saving does not publish your profile."
              : "Sign in for private account storage. Local drafts and explicit sharing work without an account."
        }
        onSaveAccount={async (profile) => {
          await accountProfile("PUT", profile);
        }}
        onLoadAccount={() => accountProfile("GET")}
      />
    </>
  );
}
