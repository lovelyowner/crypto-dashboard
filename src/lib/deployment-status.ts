export type DeploymentStatus =
  | { preview: false }
  | {
      preview: true;
      branchUrl?: string;
      deploymentUrl?: string;
      commit?: string;
      branch?: string;
    };

type Environment = Readonly<Record<string, string | undefined>>;

/** Vercel supplies hostnames; accept explicit HTTPS origins for the public parser too. */
function vercelOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 262) return undefined;
  const match = /^(?:https:\/\/)?([a-z0-9.-]+\.vercel\.app)\/?$/i.exec(value);
  if (!match) return undefined;
  const hostname = match[1].toLowerCase();
  if (
    hostname.length > 253 ||
    hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return undefined;
  return `https://${hostname}`;
}

function commitSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function branchName(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9_-])?$/i.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    return undefined;
  return value;
}

/** Public build metadata comes only from Vercel system variables, never request headers. */
export function readDeploymentStatus(environment: Environment): DeploymentStatus {
  if (environment.VERCEL !== "1" || environment.VERCEL_ENV !== "preview") return { preview: false };
  const branchUrl = vercelOrigin(environment.VERCEL_BRANCH_URL);
  const deploymentUrl = vercelOrigin(environment.VERCEL_URL);
  const commit = commitSha(environment.VERCEL_GIT_COMMIT_SHA);
  const branch = branchName(environment.VERCEL_GIT_COMMIT_REF);
  return {
    preview: true,
    ...(branchUrl ? { branchUrl } : {}),
    ...(deploymentUrl ? { deploymentUrl } : {}),
    ...(commit ? { commit } : {}),
    ...(branch ? { branch } : {}),
  };
}

/** Validate the same small public schema before rendering any server-provided link. */
export function parseDeploymentStatus(value: unknown): DeploymentStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.preview === false) return Object.keys(data).length === 1 ? { preview: false } : null;
  if (data.preview !== true) return null;
  const validators = {
    branchUrl: vercelOrigin,
    deploymentUrl: vercelOrigin,
    commit: commitSha,
    branch: branchName,
  };
  const result: Extract<DeploymentStatus, { preview: true }> = { preview: true };
  for (const key of Object.keys(data)) {
    if (key === "preview") continue;
    if (!Object.hasOwn(validators, key)) return null;
    const field = key as keyof typeof validators;
    const parsed = validators[field](data[key]);
    if (!parsed) return null;
    // API URLs must already use HTTPS, even though Vercel's environment supplies bare hosts.
    if ((field === "branchUrl" || field === "deploymentUrl") && data[key] !== parsed) return null;
    result[field] = parsed;
  }
  return result;
}

/** Public and independent of account configuration, databases, or provider availability. */
export function handleDeploymentStatusRequest(
  request: Request,
  environment: Environment = process.env,
): Response {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method !== "GET")
    return Response.json(
      { message: "Method not allowed." },
      { status: 405, headers: { ...headers, Allow: "GET" } },
    );
  return Response.json(readDeploymentStatus(environment), { headers });
}
