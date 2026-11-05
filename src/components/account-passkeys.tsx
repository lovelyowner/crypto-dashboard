import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import {
  beginPasskeyCeremony,
  browserSupportsPasskeys,
  cancelPasskeyCeremony,
  endPasskeyCeremony,
} from "@/lib/auth/passkeys-browser";
import { isFreshAccountSession } from "@/lib/auth/policy";
import "./account-passkeys.css";

type Passkey = {
  id: string;
  name?: string;
  createdAt: string;
  deviceType: string;
  backedUp: boolean;
};

function parsePasskeys(input: unknown): Passkey[] {
  if (!Array.isArray(input) || input.length > 1000)
    throw new Error("Unexpected passkey list. Refresh and retry.");
  return input.map((value: unknown) => {
    if (!value || typeof value !== "object")
      throw new Error("Unexpected passkey details. Refresh and retry.");
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 256 ||
      (row.name !== undefined &&
        row.name !== null &&
        (typeof row.name !== "string" || row.name.length > 80)) ||
      typeof row.createdAt !== "string" ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      typeof row.deviceType !== "string" ||
      !["singleDevice", "multiDevice"].includes(row.deviceType) ||
      typeof row.backedUp !== "boolean"
    )
      throw new Error("Unexpected passkey details. Refresh and retry.");
    return {
      id: row.id,
      name: typeof row.name === "string" ? row.name : undefined,
      createdAt: row.createdAt,
      deviceType: row.deviceType,
      backedUp: row.backedUp,
    };
  });
}

export function AccountPasskeys({
  userId,
  createdAt,
  available,
  origin,
}: {
  userId: string;
  createdAt: string | Date;
  available: boolean;
  origin?: string;
}) {
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [name, setName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [supported, setSupported] = useState(false);
  const active = useRef(true);
  const operation = useRef<AbortController | null>(null);
  const fresh = isFreshAccountSession(createdAt);

  async function load(signal: AbortSignal) {
    const response = await fetch("/api/auth/passkey/list-user-passkeys", {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Sign in again to manage passkeys."
          : "Could not load passkeys. Retry below.",
      );
    const result = parsePasskeys(await response.json());
    if (!active.current || signal.aborted) return;
    setKeys(result);
    setNames(Object.fromEntries(result.map((key) => [key.id, key.name || "Passkey"])));
    setLoaded(true);
  }

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setSupported(browserSupportsPasskeys(origin));
    if (available)
      void load(controller.signal).catch((cause: unknown) => {
        if (!controller.signal.aborted && active.current)
          setError(cause instanceof Error ? cause.message : "Could not load passkeys.");
      });
    return () => {
      active.current = false;
      controller.abort();
      operation.current?.abort();
      cancelPasskeyCeremony();
    };
  }, [userId, available, origin]);

  async function run(action: (signal: AbortSignal) => Promise<void>, message: string) {
    const controller = beginPasskeyCeremony();
    operation.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(controller.signal);
      if (controller.signal.aborted || !active.current) return;
      await load(controller.signal);
      if (active.current && !controller.signal.aborted) setNotice(message);
    } catch (cause) {
      if (active.current && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Passkey request failed.");
    } finally {
      if (active.current) setBusy(false);
      if (operation.current === controller) operation.current = null;
      endPasskeyCeremony(controller);
    }
  }

  async function mutate(path: string, body: Record<string, string>, signal: AbortSignal) {
    const response = await fetch(`/api/auth/passkey/${path}`, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.message || "Passkey request failed. Sign in again and retry.");
  }

  return (
    <section className="account-passkeys" aria-label="Passkey security">
      <div className="account-section-heading">
        <KeyRound size={17} />
        <h3>Passkeys</h3>
      </div>
      <p className="account-help">
        Sign in with your device, security key, or password manager. Passkeys are account
        credentials, not wallet keys or wallet recovery words. Keep your email/password or a linked
        provider as another way in. Accounts with 2FA still require an authenticator or backup code.
      </p>
      {!available ? (
        <p className="account-help">
          Passkeys require a configured account server with HTTPS (or localhost).
        </p>
      ) : (
        <>
          {!supported && (
            <p className="account-help">
              To add a passkey, use a WebAuthn browser at{" "}
              {origin || "the configured secure account origin"}. You can still manage existing
              passkeys here.
            </p>
          )}
          {!fresh && (
            <p className="account-help">
              Sign out and sign in again before adding, renaming, or removing a passkey. These
              changes require authentication within 10 minutes.
            </p>
          )}
          {error && (
            <p role="alert" className="account-message account-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="account-message account-success">
              {notice}
            </p>
          )}
          {loaded && keys.length === 0 && (
            <p className="account-help">No passkeys saved to this account.</p>
          )}
          <div className="account-passkey-list">
            {keys.map((key) => (
              <div className="account-passkey" key={key.id}>
                <label className="account-label">
                  Passkey name
                  <input
                    maxLength={80}
                    value={names[key.id] || ""}
                    onChange={(event) => setNames({ ...names, [key.id]: event.target.value })}
                    disabled={busy || !fresh}
                  />
                </label>
                <small>
                  Added {new Date(key.createdAt).toLocaleDateString()} ·{" "}
                  {key.backedUp ? "Backed up by authenticator" : "Authenticator reports no backup"}
                </small>
                <div className="account-actions">
                  <button
                    type="button"
                    className="account-secondary"
                    disabled={
                      busy ||
                      !fresh ||
                      !names[key.id]?.trim() ||
                      names[key.id] === (key.name || "Passkey")
                    }
                    onClick={() =>
                      void run(
                        (signal) =>
                          mutate(
                            "update-passkey",
                            { id: key.id, name: names[key.id].trim() },
                            signal,
                          ),
                        "Passkey renamed.",
                      )
                    }
                  >
                    Save name
                  </button>
                  <button
                    type="button"
                    className="account-danger"
                    disabled={busy || !fresh}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Remove this passkey from your account? Keep another sign-in method available. This does not remove the credential from your device.",
                        )
                      )
                        void run(
                          (signal) => mutate("delete-passkey", { id: key.id }, signal),
                          "Passkey removed from this account. You can also delete its saved copy in your device or password manager.",
                        );
                    }}
                  >
                    Remove passkey
                  </button>
                </div>
              </div>
            ))}
          </div>
          <label className="account-label">
            New passkey name
            <input
              value={name}
              maxLength={80}
              placeholder="For example, personal laptop"
              onChange={(event) => setName(event.target.value)}
              disabled={busy || !fresh}
            />
          </label>
          <div className="account-actions">
            {supported && (
              <button
                type="button"
                className="account-secondary"
                disabled={busy || !fresh || !loaded}
                onClick={() =>
                  void run(async (signal) => {
                    const result = await authClient.passkey.addPasskey({
                      name: name.trim() || "My passkey",
                      fetchOptions: { signal },
                    });
                    if (result.error)
                      throw new Error(
                        result.error.message ||
                          "Passkey registration was cancelled. Retry when ready.",
                      );
                    if (!signal.aborted && active.current) setName("");
                  }, "Passkey added. Your device will verify your identity when you sign in.")
                }
              >
                Add passkey
              </button>
            )}
            <button
              type="button"
              className="account-text-button"
              disabled={busy}
              onClick={() => void run(async () => {}, "Passkeys refreshed.")}
            >
              Refresh passkeys
            </button>
            {busy && (
              <button
                type="button"
                className="account-text-button"
                onClick={() => {
                  operation.current?.abort();
                  cancelPasskeyCeremony();
                  setBusy(false);
                  setNotice("Passkey request cancelled.");
                }}
              >
                Cancel passkey request
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
