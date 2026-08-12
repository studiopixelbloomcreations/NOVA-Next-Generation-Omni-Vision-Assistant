// Writes dist-cjs/package.json so the compiled CommonJS output is treated as
// CJS by Node (the parent package.json declares "type": "module"). Required so
// the Electron CommonJS main process can require() the New Backend build.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = `${here}/../dist-cjs`;
mkdirSync(out, { recursive: true });
writeFileSync(
  `${out}/package.json`,
  JSON.stringify({ name: 'nova-genesis-new-backend-cjs', type: 'commonjs', main: 'index.js' }, null, 2) + '\n',
  'utf-8',
);
console.log('wrote dist-cjs/package.json (type: commonjs)');
