import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { pgliteDialect } from "./pglite-dialect.ts";
import { ACCOUNT_RATE_LIMIT_POLICY } from "./policy.ts";

test("database throttles are shared by independent auth instances and isolate client IPs", async () => {
  const pg = new PGlite();
  try {
    for (const name of ["0001_auth.sql", "0004_auth_rate_limit.sql"])
      await pg.exec(
        await readFile(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"),
      );
    const secret = randomBytes(32).toString("hex");
    const instance = () =>
      betterAuth({
        database: { dialect: pgliteDialect(() => pg), type: "postgres" },
        baseURL: "http://localhost:8080",
        secret,
        emailAndPassword: { enabled: true },
        rateLimit: ACCOUNT_RATE_LIMIT_POLICY,
        telemetry: { enabled: false },
        logger: { disabled: true },
      });
    const first = instance(),
      second = instance();
    const login = (auth: typeof first, ip: string) =>
      auth.handler(
        new Request("http://localhost:8080/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            origin: "http://localhost:8080",
            "content-type": "application/json",
            "x-forwarded-for": ip,
          },
          body: JSON.stringify({
            email: "missing@example.com",
            password: "invalid credentials fixture",
          }),
        }),
      );
    for (let i = 0; i < 10; i++) {
      const response = await login(i % 2 === 0 ? first : second, "192.0.2.80");
      assert.equal(response.status, 401, `Attempt ${i + 1} is processed normally`);
    }
    const denied = await login(second, "192.0.2.80");
    assert.equal(denied.status, 429, "The eleventh attempt is rejected across instances");
    assert.ok(Number(denied.headers.get("x-retry-after")) > 0);
    const independent = await login(first, "192.0.2.81");
    assert.equal(independent.status, 401, "Another IP has an independent counter");
    const counters = await pg.query<{ count: number }>(
      'select "count" from "rateLimit" order by "count" desc',
    );
    assert.deepEqual(
      counters.rows.map((row) => row.count),
      [10, 1],
    );
  } finally {
    await pg.close();
  }
});
