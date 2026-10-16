// Starts the three local test chains (Ctrl+C stops all). Ports 8545 / 8546 / 8547.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(DIR, 'node_modules', 'hardhat', 'internal', 'cli', 'cli.js');
const chains = [['1559', 8545], ['legacy', 8546], ['op', 8547]];
const procs = chains.map(([name, port]) => {
  const p = spawn(process.execPath, [cli, 'node', '--config', `hh-${name}.cjs`, '--hostname', '127.0.0.1', '--port', String(port)], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${name}:${port}]`;
  p.stdout.on('data', (d) => { const s = String(d); if (/Started HTTP|Error|error/.test(s)) process.stdout.write(`${tag} ${s.split('\n')[0]}\n`); });
  p.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  p.on('exit', (code) => console.log(`${tag} exited ${code}`));
  return p;
});
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
