import { useEffect, useRef, useState } from "react";
import { downloadFile } from "@/lib/portfolio";
import {
  CONVERSATION_EXPORT_LIMITS,
  parseConversationArchive,
  parseConversationExportSelection,
  type ConversationExportSelection,
} from "@/lib/conversation-export";

type ExportKind = "profile" | "conversations";

export function AccountDataExport() {
  const operation = useRef<AbortController | null>(null);
  const [active, setActive] = useState<ExportKind | null>(null);
  const [message, setMessage] = useState("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdThrough, setCreatedThrough] = useState("");
  const filters = useRef<HTMLDetailsElement>(null);
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
    let selection: ConversationExportSelection | null = null;
    if (kind === "conversations" && (createdFrom || createdThrough)) {
      try {
        selection = parseConversationExportSelection({
          createdFrom: createdFrom || null,
          createdThrough: createdThrough || null,
          timeZone: "UTC",
        });
      } catch {
        setMessage("Choose valid dates, with the start on or before the end date.");
        if (filters.current) filters.current.open = true;
        return;
      }
    }
    const parameters = new URLSearchParams();
    if (selection?.createdFrom) parameters.set("from", selection.createdFrom);
    if (selection?.createdThrough) parameters.set("through", selection.createdThrough);
    const endpoint = selection
      ? `/api/account/messages-export?${parameters}`
      : "/api/account/messages-export";
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
        const response = await fetch(kind === "profile" ? "/api/account/export" : endpoint, {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 401) throw new Error("Sign in to download your account data.");
          if (response.status === 403)
            throw new Error("Sign in again to download your account data.");
          if (response.status === 413) {
            if (kind === "conversations" && filters.current) filters.current.open = true;
            throw new Error("This export exceeds the download limit. Nothing was downloaded.");
          }
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
          if (
            selection
              ? archive.version !== 2 ||
                archive.selection.createdFrom !== selection.createdFrom ||
                archive.selection.createdThrough !== selection.createdThrough
              : archive.version !== 1
          )
            throw new Error("The export response did not match the selected dates.");
          const body = JSON.stringify(archive);
          if (new TextEncoder().encode(body).length > limit)
            throw new Error("This export exceeds the download limit. Nothing was downloaded.");
          downloadFile(
            selection
              ? `fathom-conversations-${selection.createdFrom ?? "start"}-through-${selection.createdThrough ?? "end"}.json`
              : "fathom-conversations.json",
            body,
          );
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
      <details ref={filters} className="account-service-details">
        <summary>Filter conversations</summary>
        <div className="account-export-dates">
          <label className="account-label">
            Created from (UTC)
            <input
              type="date"
              value={createdFrom}
              max={createdThrough || "9999-12-31"}
              min="0001-01-01"
              disabled={active !== null}
              onChange={(event) => {
                setCreatedFrom(event.target.value);
                setMessage("");
              }}
            />
          </label>
          <label className="account-label">
            Created through (UTC)
            <input
              type="date"
              value={createdThrough}
              min={createdFrom || "0001-01-01"}
              max="9999-12-31"
              disabled={active !== null}
              onChange={(event) => {
                setCreatedThrough(event.target.value);
                setMessage("");
              }}
            />
          </label>
        </div>
        {(createdFrom || createdThrough) && (
          <button
            type="button"
            className="account-text-button"
            disabled={active !== null}
            onClick={() => {
              setCreatedFrom("");
              setCreatedThrough("");
              setMessage("");
            }}
          >
            Clear dates
          </button>
        )}
        <p className="account-help">
          Dates include the full UTC day and filter when conversations were created. Every reply is
          included, even outside those dates. Leave dates empty to download all accessible
          conversations. Limit: {CONVERSATION_EXPORT_LIMITS.conversations.toLocaleString("en")}{" "}
          conversations, {CONVERSATION_EXPORT_LIMITS.replies.toLocaleString("en")} replies, and 2
          MiB. If a download is too large, choose a smaller range.
        </p>
      </details>
      {(createdFrom || createdThrough) && (
        <p className="account-help">
          Selected: conversations created {createdFrom ? `from ${displayDate(createdFrom)}` : ""}{" "}
          {createdThrough ? `through ${displayDate(createdThrough)}` : ""} (UTC).
        </p>
      )}
      <p className="account-help">
        Payment records and security secrets are excluded. Wallets and watchlists use separate
        backup controls.
      </p>
      {message && (
        <p role="status" className="account-help">
          {message}
        </p>
      )}
    </section>
  );
}

function displayDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year.slice(-2)}`;
}
