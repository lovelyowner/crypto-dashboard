import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import { PublicationConflictError } from "./public-profile";
import { createSqlPublicationStore } from "./publication-store";

const profile = (displayName: string) => ({
  ...structuredClone(DEFAULT_CREATOR_PROFILE),
  displayName,
  bio: "An explicitly published snapshot",
});

async function fixture() {
  const database = new PGlite();
  await database.exec('create table "user" ("id" text primary key)');
  const migration = await readFile(
    new URL("../../migrations/0006_public_profiles.sql", import.meta.url),
    "utf8",
  );
  await database.exec(migration);
  await database.exec(migration); // Deploy retries must be idempotent.
  await database.query('insert into "user" ("id") values ($1), ($2), ($3)', [
    "owner",
    "other",
    "third",
  ]);
  const store = createSqlPublicationStore({
    query: async <T>(text: string, params: unknown[] = []) =>
      (await database.query<T>(text, params)).rows,
  });
  return { database, store };
}

test("publication SQL isolates owners, stores snapshots, and never returns account identifiers", async () => {
  const { database, store } = await fixture();
  try {
    assert.equal(await store.read("owner"), null);
    assert.equal(await store.readPublic("creator-one"), null);
    const original = profile("Owner 🌙");
    const other = profile("Other");
    const saved = await store.publish("owner", "creator-one", original);
    assert.deepEqual(Object.keys(saved).sort(), ["handle", "profile", "published", "updatedAt"]);
    assert.equal(saved.published, true);
    assert.equal(saved.handle, "creator-one");
    assert.deepEqual(saved.profile, original);
    await store.publish("other", "creator-two", other);
    const revised = { ...original, bio: "Updated only after an explicit publish" };
    await store.publish("owner", "creator-one", revised);
    assert.deepEqual((await store.read("owner"))?.profile, revised);
    assert.deepEqual((await store.readPublic("creator-one"))?.profile, revised);
    assert.deepEqual((await store.read("other"))?.profile, other);
    assert.equal(await store.read("owner' OR true --"), null);
    assert.equal(await store.readPublic("creator-one' OR true --"), null);
    assert.equal(await store.unpublish("owner' OR true --"), null);
    assert.deepEqual((await store.read("other"))?.profile, other);
    await assert.rejects(store.publish("missing-user", "unknown-user", original), /foreign key/i);
  } finally {
    await database.close();
  }
});

test("concurrent publication claims have one owner and an existing handle cannot be renamed or stolen", async () => {
  const { database, store } = await fixture();
  try {
    const results = await Promise.allSettled([
      store.publish("owner", "shared-handle", profile("First")),
      store.publish("other", "shared-handle", profile("Second")),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof PublicationConflictError);
    const owner = await store.read("owner");
    const winner = owner ? "owner" : "other";
    const loser = owner ? "other" : "owner";
    const winnerProfile = (await store.read(winner))?.profile;
    await assert.rejects(
      store.publish(winner, "new-handle", profile("Rename")),
      PublicationConflictError,
    );
    assert.equal(await store.readPublic("new-handle"), null);
    assert.deepEqual((await store.read(winner))?.profile, winnerProfile);
    await assert.rejects(
      store.publish(loser, "shared-handle", profile("Takeover")),
      PublicationConflictError,
    );
    assert.equal(await store.read(loser), null);
    const rows = await database.query<{ total: number }>(
      "select count(*)::int as total from public_creator_profiles",
    );
    assert.equal(rows.rows[0].total, 1);
  } finally {
    await database.close();
  }
});

test("unpublishing preserves private ownership, prevents takeover, and supports explicit republishing", async () => {
  const { database, store } = await fixture();
  try {
    assert.equal(await store.unpublish("owner"), null);
    const original = profile("Owner");
    await store.publish("owner", "creator-one", original);
    const removed = await store.unpublish("owner");
    assert.equal(removed?.published, false);
    assert.deepEqual(removed?.profile, original);
    assert.equal((await store.read("owner"))?.handle, "creator-one");
    assert.equal(await store.readPublic("creator-one"), null);
    await assert.rejects(
      store.publish("other", "creator-one", profile("Takeover")),
      PublicationConflictError,
    );
    const revised = profile("Published again");
    assert.equal((await store.publish("owner", "creator-one", revised)).published, true);
    assert.deepEqual((await store.readPublic("creator-one"))?.profile, revised);
    await store.publish("other", "creator-two", profile("Other"));
    await database.query('delete from "user" where "id" = $1', ["owner"]);
    assert.equal(await store.read("owner"), null);
    assert.equal(await store.readPublic("creator-one"), null);
    assert.ok(await store.readPublic("creator-two"));
  } finally {
    await database.close();
  }
});

test("SQL constraints reject malformed handles and non-object profile JSON", async () => {
  const { database, store } = await fixture();
  try {
    for (const handle of ["ab", "UPPER", "has space", "-starts", "ends_", "a".repeat(33)]) {
      await assert.rejects(store.publish("owner", handle, profile("Owner")), /check constraint/i);
    }
    await assert.rejects(
      database.query(
        "insert into public_creator_profiles (user_id, handle, profile) values ($1, $2, $3::jsonb)",
        ["owner", "valid-handle", "[]"],
      ),
      /check constraint/i,
    );
    assert.equal(await store.read("owner"), null);
  } finally {
    await database.close();
  }
});
