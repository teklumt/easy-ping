import { MongoClient } from "mongodb";

export const TEST_MONGO_URL =
  process.env.EASY_NOTIFY_TEST_MONGO_URL ?? "mongodb://localhost:27019/?replicaSet=rs0";

export async function mongoReachable(): Promise<boolean> {
  let reachable = false;
  try {
    const probe = new MongoClient(TEST_MONGO_URL, { serverSelectionTimeoutMS: 3000 });
    await probe.connect();
    await probe.db("admin").command({ ping: 1 });
    await probe.close();
    reachable = true;
  } catch {
    reachable = false;
  }

  // Same rule as Postgres: skipping locally is convenience, skipping in CI is
  // a green build that ran none of the database tests.
  if (!reachable && process.env.CI) {
    throw new Error(
      `MongoDB unreachable at ${TEST_MONGO_URL} and CI is set. ` +
        "Database tests must not be skipped in CI — start the service before running the suite.",
    );
  }

  if (!reachable) {
    console.warn(
      `\n[easy-notify] MongoDB unreachable at ${TEST_MONGO_URL} — mongo tests skipped.\n` +
        "Run `docker compose up -d` from the repo root to exercise them.\n",
    );
  }

  return reachable;
}
