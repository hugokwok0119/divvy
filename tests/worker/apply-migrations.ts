import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';

// D1 migrations are never auto-applied by the vitest-pool-workers plugin;
// this setup file applies them once before the worker test project runs.
// `TEST_MIGRATIONS` is a test-only binding set in vitest.config.ts, not part
// of the production Env, so it's read via a local cast rather than widening
// worker/index.ts's Env.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(env.DB, TEST_MIGRATIONS);
