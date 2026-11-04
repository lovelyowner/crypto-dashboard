import { useEffect, useState } from "react";
import { ArrowLeft, Check, LoaderCircle, RefreshCw } from "lucide-react";
import {
  normalizePublicHandle,
  validatePublicCreatorProfile,
  type PublicCreatorProfile,
} from "@/lib/public-profile";
import { formatTransactionDate } from "@/lib/format";
import { PublicProfile } from "./creator-profile";
import "./public-creator-page.css";

type PageState =
  | { status: "loading" }
  | { status: "ready"; publication: PublicCreatorProfile }
  | { status: "missing" }
  | { status: "unavailable" };

/** Public visitors do not mount a dashboard, read local drafts, or query account sessions. */
export function PublicCreatorPage({ handle }: { handle: string }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    let normalized: string;
    try {
      normalized = normalizePublicHandle(handle);
    } catch {
      setState({ status: "missing" });
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setState({ status: "loading" });
    setFeedback(null);
    async function load() {
      try {
        const response = await fetch(`/api/public-profiles/${encodeURIComponent(normalized)}`, {
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!active) return;
        if (response.status === 404) {
          setState({ status: "missing" });
          return;
        }
        if (!response.ok) throw new Error("Public profile is unavailable");
        const publication = validatePublicCreatorProfile(await response.json());
        if (publication.handle !== normalized) throw new Error("Unexpected public profile");
        if (active) setState({ status: "ready", publication });
      } catch {
        if (active) setState({ status: "unavailable" });
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [handle, reload]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const previous = document.title;
    document.title = `${state.publication.profile.displayName} · Fathom`;
    return () => {
      document.title = previous;
    };
  }, [state]);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ message: `${label} copied.`, error: false });
    } catch {
      setFeedback({
        message: `Clipboard access is unavailable. Select and copy the ${label.toLowerCase()} shown on this page.`,
        error: true,
      });
    }
  }

  return (
    <main className="creator-page public-creator-page">
      <div className="public-creator-shell">
        <header className="public-creator-header">
          <a href="/" aria-label="Open Fathom workspace">
            <ArrowLeft size={14} /> fathom
          </a>
          <span>CREATOR PAGE</span>
        </header>
        {state.status === "loading" ? (
          <section className="public-creator-state" role="status">
            <LoaderCircle size={25} className="public-creator-spin" />
            <h1>Loading creator profile…</h1>
            <p>Getting the latest published page.</p>
          </section>
        ) : state.status === "missing" ? (
          <section className="public-creator-state">
            <h1>Profile unavailable</h1>
            <p>This public page does not exist or has been unpublished.</p>
            <a href="/">Open Fathom</a>
          </section>
        ) : state.status === "unavailable" ? (
          <section className="public-creator-state">
            <h1>Could not load this profile</h1>
            <p>The profile service is unavailable. Please try again.</p>
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              <RefreshCw size={14} /> Try again
            </button>
          </section>
        ) : (
          <>
            <div className="public-creator-identity">
              <h1>@{state.publication.handle}</h1>
              <span>
                Updated{" "}
                <time dateTime={state.publication.updatedAt} title={state.publication.updatedAt}>
                  {formatTransactionDate(new Date(state.publication.updatedAt).getTime())} UTC
                </time>
              </span>
            </div>
            {feedback && (
              <p className="public-creator-feedback" role={feedback.error ? "alert" : "status"}>
                {!feedback.error && <Check size={14} />} {feedback.message}
              </p>
            )}
            <PublicProfile
              profile={state.publication.profile}
              published
              onCopy={(value, label) => void copy(value, label)}
            />
            <footer className="public-creator-footer">
              <p>
                This page contains information provided by its creator. Links and receiving
                addresses do not prove account or wallet ownership.
              </p>
              <a href="/">Create your own profile with Fathom</a>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
