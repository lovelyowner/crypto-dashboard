import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import { createSqlProfileStore } from "./profile-store";

test("profile migration and SQL keep account drafts separate, parameterized, and tied to user deletion", async () => {
  const database = new PGlite();
  try {
    await database.exec('create table "user" ("id" text primary key)');
    await database.exec(
      await readFile(
        new URL("../../migrations/0005_creator_profiles.sql", import.meta.url),
        "utf8",
      ),
    );
    await database.query('insert into "user" ("id") values ($1), ($2)', ["owner", "other"]);
    const store = createSqlProfileStore({
      query: async <T>(text: string, params: unknown[] = []) =>
        (await database.query<T>(text, params)).rows,
    });
    const original = { ...structuredClone(DEFAULT_CREATOR_PROFILE), displayName: "Owner" };
    const other = { ...structuredClone(DEFAULT_CREATOR_PROFILE), displayName: "Other" };
    assert.equal(await store.read("owner"), null);
    await store.write("owner", original);
    await store.write("other", other);
    const revised = { ...original, bio: "An updated profile" };
    await store.write("owner", revised);
    assert.deepEqual((await store.read("owner"))?.profile, revised);
    assert.deepEqual((await store.read("other"))?.profile, other);
    assert.equal(await store.read("owner' OR true --"), null);
    const count = await database.query<{ total: number }>(
      "select count(*)::int as total from creator_profiles",
    );
    assert.equal(count.rows[0].total, 2);
    await assert.rejects(store.write("missing-user", original), /foreign key/i);
    await database.query('delete from "user" where "id" = $1', ["owner"]);
    assert.equal(await store.read("owner"), null);
    assert.deepEqual((await store.read("other"))?.profile, other);
  } finally {
    await database.close();
  }
});
