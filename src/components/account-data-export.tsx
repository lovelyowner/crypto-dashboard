import { useEffect, useRef, useState } from "react";
import { downloadFile } from "@/lib/portfolio";
import { CONVERSATION_EXPORT_LIMITS, parseConversationArchive } from "@/lib/conversation-export";

type ExportKind = "profile" | "conversations";

export function AccountDataExport() {
  const operation = useRef<AbortController | null>(null);
  const [active, setActive] = useState<ExportKind | null>(null);
  const [message, setMessage] = useState("");
  useEffect(
    () => () => {
      const controller = operation.current;
      operation.current = null;
      controller?.abort();
    },
    [],
  );

  const stopDownload = (controller: AbortController | null, message: string) => {
    if (!controller || operation.current !== controller) return;
    operation.current = null;
    setActive(null);
    setMessage(message);
    controller.abort();
  };

  const download = (kind: ExportKind) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setActive(kind);
    setMessage("");
    void (async () => {
      const timer = window.setTimeout(() => {
        stopDownload(controller, "The download timed out. Try again.");
      }, 15_000);
      const limit = kind === "profile" ? 262_144 : CONVERSATION_EXPORT_LIMITS.bytes;
      try {
        const response = await fetch(
          kind === "profile" ? "/api/account/export" : "/api/account/messages-export",
          {
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          if (response.status === 401) throw new Error("Sign in to download your account data.");
          if (response.status === 403)
            throw new Error("Sign in again to download your account data.");
          if (response.status === 413)
            throw new Error("This export exceeds the download limit. Nothing was downloaded.");
          throw new Error("Could not download account data. Try again.");
        }
        if (
          response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
          "application/json"
        )
          throw new Error("The export response could not be read.");
        const raw = await response.text();
        if (controller.signal.aborted || operation.current !== controller) return;
        if (new TextEncoder().encode(raw).length > limit)
          throw new Error("This export exceeds the download limit. Nothing was downloaded.");
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          throw new Error("The export response could not be read.");
        }
        if (kind === "conversations") {
          const archive = parseConversationArchive(value);
          const body = JSON.stringify(archive);
          if (new TextEncoder().encode(body).length > limit)
            throw new Error("This export exceeds the download limit. Nothing was downloaded.");
          downloadFile("fathom-conversations.json", body);
          setMessage(
            `Downloaded ${archive.counts.conversations} conversations and ${archive.counts.replies} replies.`,
          );
        } else {
          if (value?.version !== 1 || value.scope !== "account-profile")
            throw new Error("The export response could not be read.");
          downloadFile("fathom-account-profile.json", raw);
          setMessage("Account and profile data downloaded.");
        }
      } catch (cause) {
        if (operation.current === controller)
          setMessage(
            controller.signal.aborted
              ? "Download cancelled."
              : cause instanceof Error
                ? cause.message
                : "Could not download account data.",
          );
      } finally {
        window.clearTimeout(timer);
        if (operation.current === controller) {
          operation.current = null;
          setActive(null);
        }
      }
    })();
  };

  return (
    <section className="account-data-export" aria-label="Account data export">
      <h3>Account data</h3>
      <p className="account-help">
        Sign in within the last ten minutes, then choose a JSON download.
      </p>
      <div className="account-actions">
        <button
          className="account-secondary"
          type="button"
          disabled={active !== null}
          onClick={() => download("profile")}
        >
          {active === "profile" ? "Preparing download…" : "Download account and profile data"}
        </button>
        <button
          className="account-secondary"
          type="button"
          disabled={active !== null}
          onClick={() => download("conversations")}
        >
          {active === "conversations" ? "Preparing conversations…" : "Download conversations"}
        </button>
        {active && (
          <button
            className="account-text-button"
            type="button"
            onClick={() => stopDownload(operation.current, "Download cancelled.")}
          >
            Cancel download
          </button>
        )}
      </div>
      <p className="account-help">
        Conversation downloads include every reply in the conversations you can access in your
        inbox. Limit: {CONVERSATION_EXPORT_LIMITS.conversations.toLocaleString("en")} conversations,{" "}
        {CONVERSATION_EXPORT_LIMITS.replies.toLocaleString("en")} replies, and 2 MiB. Oversized
        exports are rejected. Payment records and security secrets are excluded. Wallets and
        watchlists use their own backup controls.
      </p>
      {message && (
        <p role="status" className="account-help">
          {message}
        </p>
      )}
    </section>
  );
}
