// Phase 3 reuses the same browser workflow as phase 2 so results remain comparable.
if (!process.argv.slice(2).some((arg) => arg === '--output' || arg.startsWith('--output='))) {
  process.argv.push('--output', 'bench/results/phase3-browser.json');
}
await import('./phase2-browser.mjs');
