import mysql from "mysql2/promise";

export const TEST_MYSQL_URL =
  process.env.EASY_PING_TEST_MYSQL_URL ?? "mysql://root:easyping@localhost:33069/easyping_test";

export async function mysqlReachable(): Promise<boolean> {
  let reachable = false;
  try {
    const probe = await mysql.createConnection({ uri: TEST_MYSQL_URL, connectTimeout: 3000 });
    await probe.ping();
    await probe.end();
    reachable = true;
  } catch {
    reachable = false;
  }

  // Same rule as the others: skipping locally is convenience, skipping in CI
  // is a green build that ran none of the MySQL tests.
  if (!reachable && process.env.CI) {
    throw new Error(
      `MySQL unreachable at ${TEST_MYSQL_URL} and CI is set. ` +
        "Database tests must not be skipped in CI — start the service before running the suite.",
    );
  }

  if (!reachable) {
    console.warn(
      `\n[easy-ping] MySQL unreachable at ${TEST_MYSQL_URL} — mysql tests skipped.\n` +
        "Run `docker compose up -d` from the repo root to exercise them.\n",
    );
  }

  return reachable;
}
