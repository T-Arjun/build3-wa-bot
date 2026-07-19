'use strict';

// CLI entry: `npm run sync` (or `npm run sync:dry`).
const { runSync } = require('./syncWorker');

const dryRun = process.argv.includes('--dry-run');

runSync({ dryRun })
  .then((stats) => {
    // Was `? 0 : 0` - always exited success even when founders were skipped,
    // so a cron/CI wrapper checking the exit code could never see a partial
    // failure (the errors themselves were already recorded in sync_runs -
    // this only affects whether the PROCESS exit code reflects that).
    process.exit(stats.errors.length ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
