'use strict';

const cron = require('node-cron');
const { env } = require('../config/env');
const { runSync } = require('./syncWorker');
const log = require('../lib/logger');

/**
 * Schedule the 6-hour sync (cron from SYNC_CRON) and optionally run once on boot.
 * Guards against overlapping runs.
 */
function startSyncSchedule() {
  let running = false;

  async function safeRun(reason) {
    if (running) {
      log.warn(`sync skipped (${reason}) - previous run still in progress`);
      return;
    }
    running = true;
    try {
      await runSync();
    } catch (err) {
      log.error(`scheduled sync (${reason}) failed:`, err.message);
    } finally {
      running = false;
    }
  }

  if (!cron.validate(env.sync.cron)) {
    log.error(`invalid SYNC_CRON "${env.sync.cron}" - sync schedule not started`);
    return;
  }

  cron.schedule(env.sync.cron, () => safeRun('cron'), { timezone: 'Asia/Kolkata' });
  log.info(`sync scheduled: "${env.sync.cron}" (Asia/Kolkata)`);

  if (env.sync.onBoot) {
    // Defer slightly so the HTTP server is up first.
    setTimeout(() => safeRun('boot'), 3000);
  }
}

module.exports = { startSyncSchedule };
