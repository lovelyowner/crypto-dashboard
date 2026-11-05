export const REPORT_REASONS = ["spam", "harassment", "scam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatus = "open" | "reviewed" | "dismissed";
export type ContactModeration = {
  canBlock: boolean;
  blocked: boolean;
  canReport: boolean;
  reported: boolean;
};
export type ModerationReport = {
  id: string;
  messageId: string;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  createdAt: string;
  message: { text: string; kind: "dm" | "donation"; anonymous: boolean };
  replies: { text: string; fromCreator: boolean; createdAt: string }[];
};
export function isContactBlockedError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P0001" &&
    "message" in error &&
    error.message === "Contact is blocked.",
  );
}
