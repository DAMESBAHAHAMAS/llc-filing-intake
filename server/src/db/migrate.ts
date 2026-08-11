import "dotenv/config";
import { pool } from "./pool.js";
import { runMigrations } from "./migrationRunner.js";
import { describeError } from "./describeError.js";

async function main() {
  console.log("Running migrations...");
  const { applied, skipped } = await runMigrations(pool);
  if (applied.length) {
    console.log(`Applied: ${applied.join(", ")}`);
  } else {
    console.log("No pending migrations.");
  }
  if (skipped.length) {
    console.log(`Already applied (skipped): ${skipped.join(", ")}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error("Migration run failed:", describeError(err));
  process.exitCode = 1;
});
