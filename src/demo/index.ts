// Loaded only through `import('./demo')`, so none of this reaches the main bundle.
import { setDemoMode } from '../lib/demo-mode';
import { buildDemoData } from './data';
import { demoFetch } from './guard';
import sampleResults from './sample-results.json';
import { createDemoServer } from './server';
import type { SampleResult } from './types';

export { DemoBanner } from './DemoBanner';
export { HowItWorksCard } from './HowItWorksCard';

let installed = false;

/** Routes every same-origin `/api` request to the in-memory demo. A second call is a no-op. */
export function install(): void {
  if (installed) return;
  const samples = sampleResults.samples as SampleResult[];
  const server = createDemoServer(buildDemoData(samples), samples);
  globalThis.fetch = demoFetch(globalThis.fetch.bind(globalThis), location.origin, server.handle);
  setDemoMode(true);
  // Set last, so a throw above leaves a retry that really installs (fail closed).
  installed = true;
}

/** A full page load of `/` wipes demo state and restores the real `fetch`. */
export function exitDemo(): void {
  location.assign('/');
}
