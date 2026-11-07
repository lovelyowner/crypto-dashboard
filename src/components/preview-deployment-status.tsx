import { useEffect, useState } from "react";
import { parseDeploymentStatus, type DeploymentStatus } from "@/lib/deployment-status";
import "./preview-deployment-status.css";

export function PreviewDeploymentStatus() {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4_000);
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/deployment", {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const result = parseDeploymentStatus(await response.json());
        if (active && !controller.signal.aborted) setStatus(result);
      } catch {
        // Build status is optional; failures must not interrupt the dashboard.
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);
  if (!status?.preview) return null;
  return (
    <details className="preview-deployment-status">
      <summary>Preview build{status.commit ? ` ${status.commit.slice(0, 7)}` : ""}</summary>
      <div className="preview-deployment-status-content">
        <dl>
          {status.branch && (
            <div>
              <dt>Branch</dt>
              <dd>{status.branch}</dd>
            </div>
          )}
          {status.commit && (
            <div>
              <dt>Commit</dt>
              <dd>
                <code>{status.commit}</code>
              </dd>
            </div>
          )}
        </dl>
        {status.branchUrl && (
          <>
            <p>Deployment URLs stay on one build. This branch link follows successful updates.</p>
            <a href={status.branchUrl} target="_blank" rel="noreferrer noopener">
              Open latest preview
            </a>
            <p>
              Each website address has separate local wallets and watchlists. Keep backups before
              moving to a different address.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
