import { useEffect, useRef, useState } from "react";
import { downloadFile } from "@/lib/portfolio";

export function AccountDataExport() {
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(
    () => () => {
      const controller = operation.current;
      operation.current = null;
      controller?.abort();
    },
    [],
  );
  return (
    <section className="account-data-export" aria-label="Account data export">
      <h3>Account data</h3>
      <p className="account-help">
        Download account details, linked service IDs, and private/published profiles. Wallets,
        watchlists, messages, and payments need separate backups. Sign in within the last ten
        minutes to export.
      </p>
      <button
        className="account-secondary"
        type="button"
        disabled={busy}
        onClick={() => {
          void (async () => {
            const controller = new AbortController();
            operation.current = controller;
            setBusy(true);
            setMessage("");
            const timer = window.setTimeout(() => controller.abort(), 15_000);
            try {
              const response = await fetch("/api/account/export", {
                cache: "no-store",
                credentials: "same-origin",
                redirect: "error",
                signal: controller.signal,
              });
              if (!response.ok)
                throw new Error(
                  response.status === 403
                    ? "Sign in again to download your account data."
                    : "Could not download account data. Try again.",
                );
              const raw = await response.text();
              if (controller.signal.aborted) return;
              let value;
              try {
                value = JSON.parse(raw);
              } catch {
                throw new Error("The export response could not be read.");
              }
              if (raw.length > 262_144 || value.version !== 1 || value.scope !== "account-profile")
                throw new Error("The export response could not be read.");
              downloadFile("fathom-account-profile.json", raw);
              setMessage("Account and profile data downloaded.");
            } catch (cause) {
              if (!controller.signal.aborted)
                setMessage(
                  cause instanceof Error ? cause.message : "Could not download account data.",
                );
            } finally {
              window.clearTimeout(timer);
              if (!controller.signal.aborted && operation.current === controller) setBusy(false);
              else if (operation.current === controller) {
                setBusy(false);
                setMessage("The download was cancelled or timed out. Try again.");
              }
            }
          })();
        }}
      >
        {busy ? "Preparing download…" : "Download account and profile data"}
      </button>
      {message && (
        <p role="status" className="account-help">
          {message}
        </p>
      )}
    </section>
  );
}
