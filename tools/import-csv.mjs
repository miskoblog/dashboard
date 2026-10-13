#!/usr/bin/env node
/**
 * Turns admin-console CSV exports into a usage.json the dashboard can read.
 *
 *   node tools/import-csv.mjs --in imports --dry-run    # inspect, write nothing
 *   node tools/import-csv.mjs --in imports              # write data/usage.*
 *
 * Reads imports/manifest.json, which names each app, its per-seat member
 * export, and (optionally) its activity export. Column names are detected
 * from the headers; the manifest can override any of them when a header is
 * too unusual to guess.
 *
 * People are joined across files by EMAIL, lowercased. It is the only key
 * every admin console agrees on. Someone whose email differs between two
 * exports will appear as two people, which is why --dry-run prints the
 * per-file counts: a surprising total usually means a mismatched address.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { parseCsv, findColumn, parseDate, parseNumber } from './lib/csv.mjs';

/* ------------------------------------------------------------- options --- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const IN = resolve(opt('in', 'imports'));
const OUT = resolve(opt('out', 'data/usage.json'));
const DRY = flag('dry-run');

const COLUMNS = {
  email:         ['email', 'email address', 'user email', 'member email', 'login', 'username', 'user', 'account'],
  name:          ['full name', 'display name', 'name', 'member name', 'user name'],
  team:          ['team', 'department', 'group', 'division', 'org', 'cost center', 'cost centre'],
  joinedAt:      ['joined', 'join date', 'start date', 'hire date', 'member since', 'created at', 'created'],
  assignedAt:    ['assigned', 'assigned at', 'granted', 'licence date', 'license date', 'added at', 'added'],
  lastActive:    ['last active', 'last activity', 'last seen', 'last login', 'last sign in', 'last signin',
                  'last access', 'last used'],
  status:        ['status', 'state', 'account status', 'membership'],
  date:          ['date', 'day', 'activity date', 'event date', 'timestamp'],
  logins:        ['logins', 'log ins', 'sign ins', 'signins', 'sessions', 'login count', 'session count'],
  activeMinutes: ['active minutes', 'minutes', 'time spent', 'duration', 'active time', 'usage minutes'],
  actions:       ['actions', 'events', 'activities', 'interactions', 'messages posted', 'edits'],
};
const DEACTIVATED = /^(deactivated|deactivate|inactive|disabled|suspended|removed|revoked|archived|false|no|0)$/i;

const notes = [], problems = [];
const die = (msg) => { console.error('FAIL  ' + msg); process.exit(1); };

/* ------------------------------------------------------------ manifest --- */
const manifestPath = join(IN, 'manifest.json');
if (!existsSync(manifestPath)) {
  die(`no manifest at ${manifestPath}\n` +
      '      Copy imports/manifest.example.json to imports/manifest.json and edit it.');
}
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
catch (e) { die(`manifest.json is not valid JSON: ${e.message}`); }
if (!Array.isArray(manifest.apps) || !manifest.apps.length) die('manifest has no "apps"');

const DAY_FIRST = flag('day-first') || manifest.dayFirst === true;

/** Read a CSV named by the manifest, resolving its columns once. */
function readTable(spec, label, needed) {
  const file = typeof spec === 'string' ? spec : spec && spec.file;
  if (!file) return null;
  const path = join(IN, file);
  if (!existsSync(path)) { problems.push(`${label}: file not found: ${file}`); return null; }

  const { headers, records } = parseCsv(readFileSync(path, 'utf8'));
  if (!headers.length) { problems.push(`${label}: ${file} is empty`); return null; }

  const override = (typeof spec === 'object' && spec.columns) || {};
  const cols = {}, detected = [];
  for (const key of needed) {
    const chosen = override[key] || findColumn(headers, COLUMNS[key] || [key]);
    cols[key] = chosen;
    if (chosen) detected.push(`${key}=${JSON.stringify(chosen)}${override[key] ? '*' : ''}`);
  }
  notes.push(`  ${label}: ${file} — ${records.length} rows; ${detected.join(', ') || 'no columns matched'}`);
  if (!cols.email) {
    problems.push(`${label}: no email column found in ${file}. Headers: ${headers.join(' | ')}. ` +
                  'Set it explicitly with "columns": { "email": "<header>" }.');
  }
  return { path, file, headers, records, cols, label };
}

const val = (row, cols, key) => (cols[key] ? row[cols[key]] : undefined);
const emailOf = (row, cols) => String(val(row, cols, 'email') || '').trim().toLowerCase();

/* -------------------------------------------------------------- people --- */
const people = new Map();   // email -> person
let personSeq = 0;
function upsertPerson(email, fields) {
  if (!email) return null;
  let p = people.get(email);
  if (!p) {
    p = { id: 'u' + String(++personSeq).padStart(3, '0'), email, name: '', team: '', joinedAt: null };
    people.set(email, p);
  }
  if (fields.name && !p.name) p.name = fields.name;
  if (fields.team && !p.team) p.team = fields.team;
  if (fields.joinedAt && !p.joinedAt) p.joinedAt = fields.joinedAt;
  return p;
}

notes.push('Files read:');
const roster = readTable(manifest.people, 'people', ['email', 'name', 'team', 'joinedAt']);
if (roster) {
  for (const row of roster.records) {
    const email = emailOf(row, roster.cols);
    if (!email) continue;
    upsertPerson(email, {
      name: val(row, roster.cols, 'name'),
      team: val(row, roster.cols, 'team'),
      joinedAt: parseDate(val(row, roster.cols, 'joinedAt'), DAY_FIRST),
    });
  }
}

/* --------------------------------------------- apps, seats and activity --- */
const apps = [], assignments = [], events = [];
let skippedDeactivated = 0, unparsedDates = 0;
const appsWithActivity = [], appsWithoutActivity = [];
const lastActiveBySeat = new Map();

for (const app of manifest.apps) {
  if (!app.id || !app.name) die(`every app needs an "id" and a "name" (offending entry: ${JSON.stringify(app)})`);
  apps.push({
    id: app.id,
    name: app.name,
    category: app.category || 'Uncategorised',
    seatCostMonthly: Number(app.seatCostMonthly) || 0,
  });
  if (!(Number(app.seatCostMonthly) > 0)) {
    problems.push(`${app.id}: no "seatCostMonthly" — every cost figure for this app will read $0`);
  }

  const seats = readTable(app.seats, `${app.id} seats`, ['email', 'name', 'team', 'lastActive', 'assignedAt', 'status']);
  if (!seats) { problems.push(`${app.id}: no seat list, so this app has no seats and will not appear`); continue; }

  const seen = new Set();
  for (const row of seats.records) {
    const email = emailOf(row, seats.cols);
    if (!email) continue;

    const status = String(val(row, seats.cols, 'status') || '').trim();
    if (status && DEACTIVATED.test(status)) { skippedDeactivated++; continue; }
    if (seen.has(email)) continue;          // the same member listed twice is still one seat
    seen.add(email);

    const person = upsertPerson(email, {
      name: val(row, seats.cols, 'name'),
      team: val(row, seats.cols, 'team'),
    });
    const rawLast = val(row, seats.cols, 'lastActive');
    const lastActive = parseDate(rawLast, DAY_FIRST);
    if (rawLast && String(rawLast).trim() && !lastActive && !/^(never|n\/?a|none|-)$/i.test(String(rawLast).trim())) {
      unparsedDates++;
    }
    assignments.push({
      personId: person.id,
      appId: app.id,
      assignedAt: parseDate(val(row, seats.cols, 'assignedAt'), DAY_FIRST),
      lastActiveAt: lastActive,
    });
    if (lastActive) lastActiveBySeat.set(person.id + '|' + app.id, lastActive);
  }

  const act = readTable(app.activity, `${app.id} activity`,
    ['email', 'date', 'logins', 'activeMinutes', 'actions']);
  if (!act) { appsWithoutActivity.push(app.id); continue; }

  let rows = 0;
  const daily = new Map();                  // "personId|date" -> aggregated row
  for (const row of act.records) {
    const email = emailOf(row, act.cols);
    const person = people.get(email);
    if (!person) continue;                  // activity for someone with no seat here
    const date = parseDate(val(row, act.cols, 'date'), DAY_FIRST);
    if (!date) { unparsedDates++; continue; }

    const key = person.id + '|' + date;
    const prev = daily.get(key) || { logins: 0, activeMinutes: 0, actions: 0 };
    // Several rows for one person-day (per session, per channel) roll up.
    prev.logins += act.cols.logins ? parseNumber(val(row, act.cols, 'logins')) : 1;
    prev.activeMinutes += parseNumber(val(row, act.cols, 'activeMinutes'));
    prev.actions += parseNumber(val(row, act.cols, 'actions'));
    daily.set(key, prev);
    rows++;
  }
  for (const [key, v] of daily) {
    const [personId, date] = key.split('|');
    events.push({
      personId, appId: app.id, date,
      logins: Math.max(1, Math.round(v.logins)),
      activeMinutes: Math.round(v.activeMinutes),
      actions: Math.round(v.actions),
    });
    const sk = personId + '|' + app.id;
    if (!lastActiveBySeat.has(sk) || lastActiveBySeat.get(sk) < date) lastActiveBySeat.set(sk, date);
  }
  if (rows) appsWithActivity.push(app.id); else appsWithoutActivity.push(app.id);
}

/* -------------------------------------------------------------- window --- */
const allDates = events.map((e) => e.date).concat([...lastActiveBySeat.values()]);
const today = new Date().toISOString().slice(0, 10);
const windowEnd = manifest.windowEnd || (allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : today);
const windowDays = Number(manifest.windowDays) || 90;
const windowStart = manifest.windowStart || (() => {
  const d = new Date(windowEnd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (windowDays - 1));
  return d.toISOString().slice(0, 10);
})();

// Dates we never learned default to the start of the window, which scores a
// seat over the whole range rather than flattering it with a short one.
for (const p of people.values()) if (!p.joinedAt) p.joinedAt = windowStart;
for (const a of assignments) {
  if (!a.assignedAt) a.assignedAt = windowStart;
  a.lastActiveAt = lastActiveBySeat.get(a.personId + '|' + a.appId) || null;
}
for (const p of people.values()) if (!p.name) p.name = p.email.split('@')[0];

/* ------------------------------------------------------------ fidelity --- */
// "full" needs real in-app activity for every app; anything less and the
// engagement tiers would mean different things on different rows.
const fidelity = manifest.fidelity
  || (appsWithoutActivity.length === 0 && events.length ? 'full' : 'last-active-only');

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'csv-import',
  fidelity,
  windowStart, windowEnd,
  days: windowDays,
  currency: manifest.currency || 'USD',
  apps,
  people: [...people.values()].map((p) => ({
    id: p.id, name: p.name, email: p.email, team: p.team || 'Unassigned', joinedAt: p.joinedAt,
  })),
  assignments,
  events: events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
};

/* -------------------------------------------------------------- report --- */
console.log(notes.join('\n'));
console.log('\nResult');
console.log(`  ${apps.length} apps · ${payload.people.length} people · ${assignments.length} seats · ${events.length} event rows`);
console.log(`  window ${windowStart} .. ${windowEnd} (${windowDays} days)`);
console.log(`  fidelity "${fidelity}"`);
if (skippedDeactivated) console.log(`  skipped ${skippedDeactivated} deactivated members (not billable seats)`);
if (unparsedDates) {
  problems.push(`${unparsedDates} dates could not be parsed. If your exports are D/M/Y, re-run with --day-first.`);
}
if (appsWithoutActivity.length) {
  console.log(`  no activity feed for: ${appsWithoutActivity.join(', ')}`);
  console.log('  -> running in last-active-only mode: the dashboard can show who has gone');
  console.log('     dark, but not who signs in without doing anything.');
}
if (problems.length) {
  console.log('\nWorth a look');
  problems.forEach((p) => console.log('  - ' + p));
}

if (DRY) { console.log('\nDry run: nothing written.'); process.exit(0); }

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(payload);
writeFileSync(OUT, json + '\n');
writeFileSync(join(dirname(OUT), 'usage.js'),
  '/* Generated by tools/import-csv.mjs - do not edit. Mirrors usage.json. */\n' +
  'window.USAGE_DATA = ' + json + ';\n');
console.log(`\nWrote ${OUT} and its usage.js mirror (${(json.length / 1024).toFixed(0)} KB).`);
console.log('Next: node tools/validate-data.mjs');
