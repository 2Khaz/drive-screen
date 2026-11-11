import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('docs', { recursive: true });
let config;
try { config = JSON.parse(await readFile('config.local.json', 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = JSON.parse(await readFile('frontend/config.json', 'utf8'));
}
if (config.apiBase) {
  const url = new URL(config.apiBase);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Public API must use HTTPS.');
  }
}
await build({
  entryPoints: ['frontend/app.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  outfile: 'docs/app.js',
  legalComments: 'eof',
});
for (const name of ['index.html', 'styles.css', 'icon.png']) await copyFile(`frontend/${name}`, `docs/${name}`);
await writeFile('docs/config.json', JSON.stringify({ apiBase: config.apiBase || '', discordClientId: config.discordClientId || '' }, null, 2) + '\n');
await writeFile('docs/.nojekyll', '');
console.log('GitHub Pages output prepared in docs/.');
