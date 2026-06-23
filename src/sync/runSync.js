'use strict';

// CLI entry: `npm run sync` (or `npm run sync:dry`).
const { runSync } = require('./syncWorker');

const dryRun = process.argv.includes('--dry-run');

runSync({ dryRun })
  .then((stats) => {
    process.exit(stats.errors.length ? 0 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
