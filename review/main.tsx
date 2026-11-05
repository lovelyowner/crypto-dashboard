import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CreatorInbox } from "@/components/creator-inbox";
import { AppErrorComponent } from "@/lib/error-component";
import {
  validateContactText,
  type ContactMessage,
  type ContactReply,
  type InboxFolder,
} from "@/lib/creator-contact";
import "./preview.css";

const creator = "preview-creator";
const sender = "preview-sender";
let currentUser = creator;
let sequence = 0;
const sampleBlocks = new Set<string>();
const sampleReports = new Set<string>();
type SampleThread = {
  message: Omit<ContactMessage, "direction" | "readAt">;
  sender: string | null;
  replies: ContactReply[];
  revision: number;
  lastAuthor: string;
  reads: Record<string, { revision: number; at: string }>;
};
const timestamp = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const threads: SampleThread[] = [
  {
    message: {
      id: "sample-collaboration",
      kind: "dm",
      anonymous: false,
      senderName: "Sam · Sample sender",
      recipientHandle: "sample-creator",
      text: "Sample collaboration question: could we make a short tutorial together?\nTry drafting a reply, switching conversations, and returning to see the draft badge.",
      createdAt: timestamp(12),
      paymentStatus: "free",
    },
    sender,
    replies: [],
    revision: 1,
    lastAuthor: sender,
    reads: {},
  },
  {
    message: {
      id: "sample-feedback",
      kind: "dm",
      anonymous: false,
      senderName: "Sam · Sample sender",
      recipientHandle: "sample-creator",
      text: "Sample feedback: the latest walkthrough was helpful. Is a follow-up planned?",
      createdAt: timestamp(90),
      paymentStatus: "free",
    },
    sender,
    replies: [
      {
        id: "sample-first-reply",
        text: "Sample creator reply: yes, another walkthrough is planned. Thanks for reading!",
        createdAt: timestamp(45),
        fromCreator: true,
      },
    ],
    revision: 2,
    lastAuthor: creator,
    reads: { [creator]: { revision: 2, at: timestamp(45) } },
  },
  {
    message: {
      id: "sample-donation",
      kind: "donation",
      anonymous: true,
      senderName: "Anonymous",
      recipientHandle: "sample-creator",
      text: "Sample anonymous donation note: thanks for the tutorial! This is fictional; no payment occurred.",
      createdAt: timestamp(180),
      paymentStatus: "paid",
    },
    sender: null,
    replies: [],
    revision: 1,
    lastAuthor: "sample-anonymous",
    reads: {},
  },
];
function visible(thread: SampleThread, viewer: string) {
  return viewer === creator || thread.sender === viewer;
}
function messageFor(thread: SampleThread, viewer: string): ContactMessage {
  const latestReply = thread.replies.at(-1) ?? null;
  const read = thread.reads[viewer];
  return {
    ...thread.message,
    direction: viewer === creator ? "received" : "sent",
    readAt: read?.at ?? null,
    lastActivityAt: latestReply?.createdAt ?? thread.message.createdAt,
    unread: thread.lastAuthor !== viewer && (read?.revision ?? 0) < thread.revision,
    latestReply,
  };
}
function folderFor(message: ContactMessage): InboxFolder {
  return message.direction === "sent"
    ? "sent"
    : message.kind === "donation"
      ? "donations"
      : "received";
}
function appendReply(thread: SampleThread, author: string, text: string) {
  const createdAt = new Date().toISOString();
  thread.replies.push({
    id: `sample-reply-${++sequence}`,
    text,
    createdAt,
    fromCreator: author === creator,
  });
  thread.revision += 1;
  thread.lastAuthor = author;
  thread.reads[author] = { revision: thread.revision, at: createdAt };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const originalFetch = window.fetch;
const onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
// The sample service is available in memory even when the computer is offline.
Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
// Every request stays in memory. Unknown routes never fall through to a real service.
window.fetch = async (input, init) => {
  const viewer = currentUser;
  const request = input instanceof Request ? input : null;
  const signal = init?.signal ?? request?.signal;
  const aborted = () => {
    if (signal?.aborted) throw new DOMException("Sample request aborted", "AbortError");
  };
  aborted();
  const url = new URL(request?.url ?? String(input), document.baseURI);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (url.origin !== window.location.origin)
    return json({ message: "This route is unavailable in the offline sample preview." }, 503);
  if (url.pathname === "/api/moderation/access" && method === "GET")
    return json({ canReview: false });
  if (!/^\/api\/inbox(?:\/|$)/.test(url.pathname))
    return json({ message: "This route is unavailable in the offline sample preview." }, 503);
  if (url.pathname === "/api/inbox" && method === "GET") {
    const folder = url.searchParams.get("folder") ?? "received";
    if (!["received", "sent", "donations"].includes(folder))
      return json({ message: "Unknown sample folder." }, 400);
    const rows = threads
      .filter((thread) => visible(thread, viewer))
      .map((thread) => messageFor(thread, viewer));
    const unreadCounts = { received: 0, sent: 0, donations: 0 };
    for (const row of rows) if (row.unread) unreadCounts[folderFor(row)] += 1;
    return json({
      messages: rows
        .filter((row) => folderFor(row) === folder)
        .sort((a, b) => Date.parse(b.lastActivityAt!) - Date.parse(a.lastActivityAt!)),
      nextCursor: null,
      unreadCounts,
    });
  }
  const route = /^\/api\/inbox\/([A-Za-z0-9_-]+)(\/(?:replies|moderation|reports))?$/.exec(
    url.pathname,
  );
  const thread = threads.find((row) => row.message.id === route?.[1]);
  if (!thread) return json({ message: "Sample conversation unavailable." }, 404);
  if (!visible(thread, viewer))
    return json({ message: "Sample conversation unavailable to this view." }, 403);
  const moderation = () => ({
    canBlock: thread.sender !== null,
    blocked: thread.sender !== null && sampleBlocks.has(viewer),
    canReport: true,
    reported: sampleReports.has(`${viewer}:${thread.message.id}`),
  });
  if (route?.[2] === "/moderation" && method === "GET") return json(moderation());
  if (route?.[2] === "/moderation" && method === "PUT") {
    if (!thread.sender) return json({ message: "This sample note has no account to block." }, 403);
    const body = JSON.parse(String(init?.body ?? "{}")) as { blocked?: unknown };
    if (typeof body.blocked !== "boolean")
      return json({ message: "Choose block or unblock." }, 400);
    if (body.blocked) sampleBlocks.add(viewer);
    else sampleBlocks.delete(viewer);
    return json(moderation());
  }
  if (route?.[2] === "/reports" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { reason?: string; details?: string };
    if (
      !["spam", "harassment", "scam", "other"].includes(body.reason ?? "") ||
      typeof body.details !== "string" ||
      [...body.details].length > 1000
    )
      return json({ message: "Check the sample report." }, 400);
    sampleReports.add(`${viewer}:${thread.message.id}`);
    return json({ reported: true });
  }
  if (method === "GET" && !route?.[2]) {
    thread.reads[viewer] = { revision: thread.revision, at: new Date().toISOString() };
    return json({ message: messageFor(thread, viewer), replies: thread.replies });
  }
  if (method === "POST" && route?.[2] === "/replies") {
    if (sampleBlocks.size || !thread.sender)
      return json({ message: "New contact is unavailable in this sample." }, 403);
    try {
      const body: unknown =
        init?.body === undefined ? await request?.json() : JSON.parse(String(init.body));
      aborted();
      if (!body || typeof body !== "object" || Object.keys(body).join() !== "text")
        return json({ message: "Send only the sample reply text." }, 400);
      appendReply(thread, viewer, validateContactText((body as { text: unknown }).text));
      return json({ message: messageFor(thread, viewer), replies: thread.replies }, 201);
    } catch (cause) {
      aborted();
      return json(
        { message: cause instanceof Error ? cause.message : "Check your sample reply." },
        400,
      );
    }
  }
  return json({ message: "This action is unavailable in the offline sample preview." }, 503);
};

function Preview() {
  const [viewer, setViewer] = useState(creator);
  const [notice, setNotice] = useState("");
  const [showError, setShowError] = useState(false);
  function switchView(next: string) {
    currentUser = next;
    setViewer(next);
    setNotice("");
  }
  function addSampleReply() {
    if (sampleBlocks.size) {
      setNotice("Unblock the sample account before adding another sample reply.");
      return;
    }
    const author = viewer === creator ? sender : creator;
    appendReply(
      threads[0],
      author,
      `Sample incoming reply ${sequence + 1}: this update appears through the real inbox refresh flow.`,
    );
    setNotice(
      "Sample reply added to the collaboration conversation. Open Received in creator view or Sent in sender view to see it.",
    );
    window.dispatchEvent(new Event("focus"));
  }
  return (
    <main
      onClickCapture={(event) => {
        if ((event.target as Element).closest(".creator-inbox a")) {
          event.preventDefault();
          setNotice("Creator profile links are unavailable in this offline sample preview.");
        }
      }}
    >
      <header className="preview-header">
        <p className="preview-eyebrow">Offline interactive review</p>
        <h1>Inbox preview · Sample data</h1>
        <p>No real accounts, payments, messages, or reports are sent.</p>
        <p className="preview-explainer">
          This uses the actual inbox interface with fictional conversations held only in memory.
          Reloading resets the sample.
        </p>
      </header>
      <div className="preview-toolbar" role="group" aria-label="Sample inbox controls">
        <button type="button" aria-pressed={viewer === creator} onClick={() => switchView(creator)}>
          Creator view
        </button>
        <button type="button" aria-pressed={viewer === sender} onClick={() => switchView(sender)}>
          Sender view
        </button>
        <button type="button" onClick={addSampleReply}>
          Add sample reply
        </button>
      </div>
      <p className="preview-help">
        {viewer === creator
          ? "Creator view: try search, unread filters, drafts, replies, copying, and Safety controls."
          : "Sender view: open Sent to see your sample messages and the creator’s replies."}{" "}
        Switching views clears unsent drafts.
      </p>
      {notice && (
        <p className="preview-notice" role="status">
          {notice}
        </p>
      )}
      <button
        className="preview-error-toggle"
        type="button"
        onClick={() => setShowError((value) => !value)}
      >
        {showError ? "Return to inbox preview" : "Preview error state"}
      </button>
      {showError ? (
        <AppErrorComponent
          error={new Error("Sample error state. This is only a preview.")}
          reset={() => setShowError(false)}
        />
      ) : (
        <CreatorInbox key={viewer} accountKey={viewer} accountAvailable={true} />
      )}
      <footer className="preview-footer">
        Sample donation payment labels are illustrative. This preview has no account, payment, or
        messaging service connection.
      </footer>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    window.fetch = originalFetch;
    if (onlineDescriptor) Object.defineProperty(navigator, "onLine", onlineDescriptor);
    else Reflect.deleteProperty(navigator, "onLine");
  });
