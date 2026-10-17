import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const packagePath = require.resolve('turndown/package.json');
const { version } = JSON.parse(await readFile(packagePath, 'utf8'));
const source = await readFile(join(dirname(packagePath), 'lib/turndown.es.js'), 'utf8');
const expected = `// Vendored from turndown ${version}, lib/turndown.es.js (MIT).\n// Regenerate with npm run vendor:turndown.\n${source}`;
const target = new URL('../src/turndown.js', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== expected) {
    throw new Error('Vendored Turndown is stale. Run npm run vendor:turndown and commit src/turndown.js.');
  }
} else {
  await writeFile(target, expected);
}
