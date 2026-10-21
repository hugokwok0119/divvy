/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs real step bodies from deploy.yml with a stubbed `npx`, under the shell GitHub would use.
const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const lines = workflow.split('\n');

function stepBody(name: string): string {
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at === -1) throw new Error(`no step named ${name}`);
  const runAt = lines.findIndex((l, i) => i > at && l.trim().startsWith('run:'));
  const run = lines[runAt].trim();
  if (run !== 'run: |') return run.replace(/^run: /, '');
  const indent = lines[runAt + 1].search(/\S/);
  const body: string[] = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() && l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

function runStep(name: string, npxScript: string) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-step-'));
  writeFileSync(join(dir, 'npx'), `#!/bin/sh\n${npxScript}\n`);
  chmodSync(join(dir, 'npx'), 0o755);
  const envFile = join(dir, 'github_env');
  writeFileSync(envFile, '');
  // GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail`; the default is plain `bash -e`.
  const flags = /^defaults:\n {2}run:\n {4}shell: bash$/m.test(workflow) ? ['--noprofile', '--norc', '-eo', 'pipefail'] : ['-e'];
  const r = spawnSync('bash', [...flags, '-c', stepBody(name)], {
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_ENV: envFile, GITHUB_REF_NAME: 'v0.0.0' },
  });
  return { status: r.status, env: readFileSync(envFile, 'utf8') };
}

describe('production deploy fails closed', () => {
  it('records the bookmark when wrangler returns one', () => {
    const r = runStep('Record a D1 restore point', `echo '{"bookmark":"bm-1"}'`);
    expect(r.status).toBe(0);
    expect(r.env).toContain('BOOKMARK=bm-1');
  });

  it('stops when the bookmark cannot be read', () => {
    expect(runStep('Record a D1 restore point', 'exit 1').status).not.toBe(0);
    expect(runStep('Record a D1 restore point', `echo '{}'`).status).not.toBe(0);
  });

  it('stops when wrangler deploy fails', () => {
    expect(runStep('Deploy', 'exit 1').status).not.toBe(0);
  });

  it('stops when the deploy output has no version id', () => {
    expect(runStep('Deploy', 'echo "Uploaded divvy"').status).not.toBe(0);
  });

  it('records the version id from the deploy output', () => {
    const r = runStep('Deploy', 'echo "Current Version ID: 0f1e2d3c-aaaa-bbbb-cccc-1234567890ab"');
    expect(r.status).toBe(0);
    expect(r.env).toContain('VERSION_ID=0f1e2d3c-aaaa-bbbb-cccc-1234567890ab');
  });

  it('gives the Cloudflare token only to wrangler steps, never to a whole job', () => {
    const tokenLines = lines.filter((l) => l.includes('CLOUDFLARE_API_TOKEN:'));
    expect(tokenLines.length).toBeGreaterThan(0);
    for (const l of tokenLines) expect(l.search(/\S/)).toBe(10);
  });
});
