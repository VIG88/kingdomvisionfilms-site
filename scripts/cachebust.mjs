/* Post-build cache-busting.
   The site loads its stylesheet and script from stable, non-content-hashed
   URLs (/assets/index.css, script.js). Cloudflare Pages serves /assets/* with
   long/immutable caching, so after a deploy a returning visitor's browser can
   keep the OLD stylesheet while receiving the NEW HTML — new markup rendered
   with stale styles. Appending a short content hash as a ?v= query changes the
   URL whenever the file content changes, forcing a fresh fetch (and leaving the
   filenames untouched, so raw-copied script.js asset paths keep working). */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const dist = resolve('dist');
const shortHash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 10);

const cssPath = resolve(dist, 'assets/index.css');
const jsPath = resolve(dist, 'script.js');
const htmlPath = resolve(dist, 'index.html');

if (!existsSync(cssPath) || !existsSync(jsPath) || !existsSync(htmlPath)) {
  console.error('cache-bust: expected build outputs missing');
  process.exit(1);
}

const cssV = shortHash(cssPath);
const jsV = shortHash(jsPath);

let html = readFileSync(htmlPath, 'utf8');
html = html.replace('href="/assets/index.css"', `href="/assets/index.css?v=${cssV}"`);
html = html.replace('src="script.js"', `src="script.js?v=${jsV}"`);
writeFileSync(htmlPath, html);

console.log(`cache-bust: index.css?v=${cssV}  script.js?v=${jsV}`);
