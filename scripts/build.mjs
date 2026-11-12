import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
await build({ entryPoints: ['frontend/audio-sw.js'], bundle: true, minify: true, format: 'iife', outfile: 'docs/audio-sw.js' });
for (const name of ['styles.css', 'icon.png']) await copyFile(`frontend/${name}`, `docs/${name}`);
const digest = async name => createHash('sha256').update(await readFile(`docs/${name}`)).digest('hex').slice(0, 12);
const html = (await readFile('frontend/index.html', 'utf8'))
  .replace('./app.js', `./app.js?v=${await digest('app.js')}`)
  .replace('./styles.css', `./styles.css?v=${await digest('styles.css')}`);
await writeFile('docs/index.html', html);
await writeFile('docs/config.json', JSON.stringify({ apiBase: config.apiBase || '', discordClientId: config.discordClientId || '' }, null, 2) + '\n');
await writeFile('docs/.nojekyll', '');
console.log('GitHub Pages output prepared in docs/.');
