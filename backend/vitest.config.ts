import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',

    /**
     * THE TEST SUITE IS HERMETIC AND OFFLINE. It must never make a model call.
     *
     * `src/config/env.ts` imports `dotenv/config`, so a local `.env` with
     * `AGENT_RUNTIME=llm` would otherwise leak in and every test would spawn
     * Claude Code subprocesses — slow, costly, non-deterministic, and (with the
     * parallel stages) enough concurrent processes to exhaust memory.
     *
     * These values are applied AFTER dotenv, so they win. Credentials are
     * explicitly blanked rather than merely unset, so a shell-exported key
     * cannot re-enable network access either.
     */
    env: {
      AGENT_RUNTIME: 'rules',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',

      // Zero simulated latency: the animation delay is for the UI, not for CI.
      AGENT_SIMULATED_LATENCY_MIN_MS: '0',
      AGENT_SIMULATED_LATENCY_MAX_MS: '0',

      // Frozen clock so the "20 days ago" fixture math is reproducible.
      DEMO_FREEZE_CLOCK: 'true',
      DEMO_NOW: '2026-09-08T10:15:00.000Z',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
