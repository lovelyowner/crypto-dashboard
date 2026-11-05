import { configuredAuthOrigin } from "./configuration";

export type AccountSetup = {
  environment: "local" | "preview" | "production";
  database: boolean;
  secret: boolean;
  origin: boolean;
};

/** Presence checks only, not connection tests. Never include credential values. */
export function readAccountSetup(
  env: Readonly<Record<string, string | undefined>>,
  productionBuild = false,
): AccountSetup {
  const preview = env.VERCEL?.trim() === "1" && env.VERCEL_ENV?.trim() !== "production";
  const production = productionBuild || env.VERCEL?.trim() === "1" || env.NODE_ENV === "production";
  if (!production) return { environment: "local", database: true, secret: true, origin: true };
  const prefix = preview ? "PREVIEW_" : "";
  return {
    environment: preview ? "preview" : "production",
    database: Boolean(env[`${prefix}DATABASE_URL`]?.trim()),
    secret: (env[`${prefix}BETTER_AUTH_SECRET`]?.trim().length ?? 0) >= 32,
    origin: Boolean(configuredAuthOrigin(env[`${prefix}BETTER_AUTH_URL`], true)),
  };
}
