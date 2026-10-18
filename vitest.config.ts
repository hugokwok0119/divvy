import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Deliberately does not extend vite.config.ts: its React and Tailwind plugins
// hang the test worker. Task 9 adds a second project for Worker/D1 tests.
//
// The brief called for `defineWorkersConfig` from
// `@cloudflare/vitest-pool-workers/config`, wrapping a `poolOptions.workers`
// block. The installed version (0.21.3) has no `/config` subpath and no
// `defineWorkersConfig` export at all — that package redesigned the
// integration around a Vite plugin, `cloudflareTest()`, added to a project's
// `plugins` array instead of a config-transform wrapper around `test`.
// Confirmed via the installed package's `dist/pool/index.d.mts` exports and
// the current developers.cloudflare.com vitest-integration docs.
//
// The brief's `miniflare: { d1Databases: ['DB'] }` also isn't enough on its
// own: it creates the binding but an empty in-memory D1, with no schema.
// D1 migrations are never auto-applied by the pool — the documented pattern
// is to read them at config time and apply them from a setup file. Without
// this every test fails with "no such table".
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'pure',
          include: ['tests/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations(path.join(dirname, 'migrations'));
            return {
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                d1Databases: ['DB'],
                bindings: { TEST_MIGRATIONS: migrations },
              },
            };
          }),
        ],
        test: {
          name: 'worker',
          include: ['tests/worker/*.test.ts'],
          setupFiles: ['./tests/worker/apply-migrations.ts'],
        },
      },
    ],
  },
});
