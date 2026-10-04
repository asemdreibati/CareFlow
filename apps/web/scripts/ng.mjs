// Thin wrapper around the Angular CLI for package.json scripts.
// pnpm forwards a literal `--` to scripts (e.g. `pnpm --filter web start -- --port 4200`),
// which `ng` rejects, so strip it. `test` always runs in single-run mode.
import { spawnSync } from 'node:child_process';
const [cmd, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => a !== '--');
if (cmd === 'test' && !args.some((a) => a.startsWith('--watch'))) args.push('--watch=false');
const r = spawnSync('ng', [cmd, ...args], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
