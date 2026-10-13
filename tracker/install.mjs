#!/usr/bin/env node
/**
 * Installs tracker/track.js into local checkouts of the ten bonus apps.
 *
 *   node tracker/install.mjs --endpoint https://adoption-collector.you.workers.dev --repos ~/apps
 *   node tracker/install.mjs --endpoint ... --repos ~/apps --dry-run     # show, change nothing
 *
 * --repos is a folder holding one checkout per app, named by its slug
 * (landed, clientbridge, bridgekit, ...). For each one this:
 *   1. copies track.js next to index.html
 *   2. adds ONE <script> tag after the existing app.js tag
 *
 * It is idempotent (running twice changes nothing) and never touches git: you
 * review the diff, commit and push each repo yourself.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPS = ['landed', 'clientbridge', 'bridgekit', 'dispatch', 'voiced', 'backlot', 'clipmath', 'bridgekeeper', 'chair', 'shelfwise'];
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = argv.includes('--dry-run');
const die = (m) => { console.error('FAIL  ' + m); process.exit(1); };

let endpoint = opt('endpoint');
if (!endpoint) die('--endpoint is required, e.g. https://adoption-collector.you.workers.dev');
try {
  const u = new URL(endpoint);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) die('--endpoint must start with https://');
  endpoint = u.origin;
} catch { die('--endpoint is not a valid address'); }
const reposDir = opt('repos');
if (!reposDir) die('--repos is required: the folder holding one checkout per app');
const REPOS = resolve(reposDir);
const SRC = join(dirname(fileURLToPath(import.meta.url)), 'track.js');
const trackerSrc = readFileSync(SRC, 'utf8');

const TAG = (app) => `<script defer src="track.js" data-app="${app}" data-endpoint="${endpoint}"></script>`;
const EXISTING = /<script[^>]*\bsrc="track\.js"[^>]*><\/script>/;
let failed = 0;
const rows = [];

for (const app of APPS) {
  const dir = join(REPOS, app), page = join(dir, 'index.html');
  if (!existsSync(page)) { rows.push([app, 'MISSING', `no ${page}`]); failed++; continue; }
  let html = readFileSync(page, 'utf8');
  const notes = [];

  if (EXISTING.test(html)) {
    const wanted = TAG(app);
    if (html.match(EXISTING)[0] === wanted) notes.push('tag already current');
    else { html = html.replace(EXISTING, wanted); notes.push('tag updated'); }
  } else {
    const after = html.match(/<script[^>]*\bsrc="app\.js[^"]*"[^>]*><\/script>/);
    if (after) {
      html = html.replace(after[0], after[0] + '\n' + TAG(app));
      notes.push('tag added after app.js');
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', TAG(app) + '\n</body>');
      notes.push('tag added before </body> (no app.js tag found)');
    } else { rows.push([app, 'FAILED', 'no place to put the tag']); failed++; continue; }
  }

  const trackerPath = join(dir, 'track.js');
  const trackerCurrent = existsSync(trackerPath) && readFileSync(trackerPath, 'utf8') === trackerSrc;
  if (!trackerCurrent) notes.push('track.js written');

  const changed = readFileSync(page, 'utf8') !== html || !trackerCurrent;
  if (changed && !DRY) {
    writeFileSync(page, html);
    if (!trackerCurrent) copyFileSync(SRC, trackerPath);
  }
  rows.push([app, changed ? (DRY ? 'WOULD CHANGE' : 'CHANGED') : 'no change', notes.join('; ')]);
}

console.log(`endpoint ${endpoint}${DRY ? '   (dry run: nothing written)' : ''}\n`);
for (const [a, s, n] of rows) console.log(a.padEnd(13), s.padEnd(13), n);
console.log(failed ? `\n${failed} app(s) need attention.` : '\nNext, in each repo: git diff, then commit and push.');
process.exit(failed ? 1 : 0);
