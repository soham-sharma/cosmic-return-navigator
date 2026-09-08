/**
 * Process entry point.
 *
 * Importing `./repositories/db` (transitively, via the app) loads and validates
 * every fixture, so a malformed fixture fails the boot rather than surfacing
 * mid-demo.
 */
import { env } from './config/env';
import { logger } from './core/logger';
import { clock } from './core/clock';
import { createApp } from './server';
import { AGENT_IDS } from './domain/agent.schema';
import { TOTAL_STAGES } from './orchestrator/pipeline.config';
import { logRuntimeSummary } from './agents/base/registry';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('Cosmic Return Navigator backend is up', {
    port: env.PORT,
    env: env.NODE_ENV,
    agents: AGENT_IDS.length,
    pipelineStages: TOTAL_STAGES,
    clockFrozen: env.DEMO_FREEZE_CLOCK,
    now: clock.nowIso(),
  });

  if (env.DEMO_FREEZE_CLOCK) {
    logger.info(
      `Clock is FROZEN at ${env.DEMO_NOW} so the "bought it 20 days ago" demo stays reproducible. Set DEMO_FREEZE_CLOCK=false to use real time.`,
    );
  }

  // Makes it unambiguous which agents are talking to a model and which are
  // running deterministic rules — the single most confusing thing to get wrong
  // when demoing, and the first thing to check when output looks unexpected.
  logRuntimeSummary();

  logger.info(`Try it:  curl -X POST http://localhost:${env.PORT}/api/v1/demo/scenarios/SCN-PRIMARY-SMARTWATCH/run -H 'content-type: application/json' -d '{}'`);
});

/* ----------------------------- graceful exit ------------------------------ */

function shutdown(signal: string): void {
  logger.info(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck SSE connection.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});

export { app, server };
