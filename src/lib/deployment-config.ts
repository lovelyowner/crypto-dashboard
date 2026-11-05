import { configuredAuthOrigin } from "./auth/configuration.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** Shared by Vercel's build-time migrator and every server-side account service.
 * Non-production Vercel deployments never inherit generic production credentials.
 */
export function resolveDeploymentConfiguration(environment: Environment, productionBuild = false) {
  const value = (name: string) => environment[name]?.trim() || undefined;
  const vercel = value("VERCEL") === "1";
  const preview = vercel && value("VERCEL_ENV") !== "production";
  const production = productionBuild || vercel || value("NODE_ENV") === "production";
  const prefix = preview ? "PREVIEW_" : "";
  const selectedDatabase = value(`${prefix}DATABASE_URL`);
  const selectedSecret = value(`${prefix}BETTER_AUTH_SECRET`);
  const selectedOrigin = configuredAuthOrigin(value(`${prefix}BETTER_AUTH_URL`), production);
  const complete = Boolean(
    selectedDatabase && selectedSecret && selectedSecret.length >= 32 && selectedOrigin,
  );
  // An incomplete preview must not migrate or read any database, even if a
  // database-only integration supplied credentials or generic values exist.
  const isolated = !preview || complete;
  return {
    production,
    preview,
    authConfigured: !production || complete,
    databaseUrl: isolated ? selectedDatabase : undefined,
    authSecret: isolated ? selectedSecret : undefined,
    authOrigin: isolated ? selectedOrigin : null,
  };
}
