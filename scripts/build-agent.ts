/** Bundle the standalone agent bridge into one Bun script the browser runtime can serve. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] || 'dist-agent');
mkdirSync(out, { recursive: true });
const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../server/agent-cli.ts')], target: 'bun', minify: true, outdir: out, naming: 'meshrooms-agent.js' });
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
const file = join(out, 'meshrooms-agent.js');
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(join(out, 'meshrooms-agent.js.sha256'), `${sha256}  meshrooms-agent.js\n`);
console.log(JSON.stringify({ file, bytes: readFileSync(file).length, sha256 }));
