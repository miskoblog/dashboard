#!/usr/bin/env node
/**
 * Checks a usage.json against the contract the dashboard relies on.
 *
 *   node tools/validate-data.mjs [data/usage.json]
 *
 * Errors mean the dashboard will be wrong or will not load; warnings mean it
 * will load but something is probably not what you intended. Exits 1 on error.
 */
import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || 'data/usage.json';
const errors = [], warnings = [], notes = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
/** Cap how many times one repeated problem is listed, so output stays readable. */
const sample = (arr, n = 3) => arr.slice(0, n).join(', ') + (arr.length > n ? `, +${arr.length - n} more` : '');

let data;
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`FAIL  cannot read ${FILE}: ${e.message}`);
  process.exit(1);
}

/* ---------------------------------------------------------- top level --- */
for (const k of ['apps', 'people', 'assignments', 'events']) {
  if (!Array.isArray(data[k])) err(`"${k}" must be an array`);
}
if (!isIso(data.windowStart)) err('"windowStart" must be a YYYY-MM-DD date');
if (!isIso(data.windowEnd)) err('"windowEnd" must be a YYYY-MM-DD date');
if (isIso(data.windowStart) && isIso(data.windowEnd) && data.windowStart > data.windowEnd) {
  err('"windowStart" is after "windowEnd"');
}
if (data.fidelity && !['full', 'last-active-only'].includes(data.fidelity)) {
  err(`"fidelity" must be "full" or "last-active-only" (got ${JSON.stringify(data.fidelity)})`);
}
if (errors.length) { report(); process.exit(1); }

/* --------------------------------------------------------------- apps --- */
const appIds = new Set();
const dupApps = [];
data.apps.forEach((a, i) => {
  if (!a || typeof a.id !== 'string' || !a.id.trim()) return err(`apps[${i}] needs a non-empty "id"`);
  if (appIds.has(a.id)) dupApps.push(a.id);
  appIds.add(a.id);
  if (typeof a.name !== 'string' || !a.name.trim()) err(`apps[${i}] (${a.id}) needs a "name"`);
  if (!isNum(a.seatCostMonthly) || a.seatCostMonthly < 0) {
    err(`apps[${i}] (${a.id}) needs a non-negative numeric "seatCostMonthly" — cost panels read this`);
  }
});
if (dupApps.length) err(`duplicate app ids: ${sample([...new Set(dupApps)])}`);
if (!data.apps.length) err('no apps — there is nothing to report on');

/* ------------------------------------------------------------- people --- */
const personIds = new Set();
const dupPeople = [], badJoined = [];
data.people.forEach((p, i) => {
  if (!p || typeof p.id !== 'string' || !p.id.trim()) return err(`people[${i}] needs a non-empty "id"`);
  if (personIds.has(p.id)) dupPeople.push(p.id);
  personIds.add(p.id);
  if (typeof p.name !== 'string' || !p.name.trim()) err(`people[${i}] (${p.id}) needs a "name"`);
  if (!isIso(p.joinedAt)) badJoined.push(p.id);
});
if (dupPeople.length) err(`duplicate person ids: ${sample([...new Set(dupPeople)])}`);
if (badJoined.length) {
  err(`${badJoined.length} people have a missing or malformed "joinedAt" (${sample(badJoined)}) — ` +
      'seats are scored over the days since this date, so a bad value skews their tiers');
}
if (!data.people.length) err('no people — there is nothing to report on');

const teams = new Set(data.people.map((p) => p.team).filter(Boolean));
if (!teams.size) warn('no "team" values — the team filter will only offer "All teams"');

/* -------------------------------------------------------- assignments --- */
const seatKeys = new Set();
const dupSeats = [], orphanSeatPerson = [], orphanSeatApp = [], badAssigned = [];
data.assignments.forEach((a, i) => {
  if (!a) return err(`assignments[${i}] is empty`);
  const key = a.personId + '|' + a.appId;
  if (seatKeys.has(key)) dupSeats.push(key);
  seatKeys.add(key);
  if (!personIds.has(a.personId)) orphanSeatPerson.push(String(a.personId));
  if (!appIds.has(a.appId)) orphanSeatApp.push(String(a.appId));
  if (!isIso(a.assignedAt)) badAssigned.push(key);
});
if (dupSeats.length) {
  err(`${dupSeats.length} duplicate assignments (${sample([...new Set(dupSeats)])}) — ` +
      'each person/app pair must appear once, or seat counts double');
}
if (orphanSeatPerson.length) err(`assignments reference unknown people: ${sample([...new Set(orphanSeatPerson)])}`);
if (orphanSeatApp.length) err(`assignments reference unknown apps: ${sample([...new Set(orphanSeatApp)])}`);
if (badAssigned.length) err(`${badAssigned.length} assignments have a bad "assignedAt" (${sample(badAssigned)})`);
if (!data.assignments.length) {
  err('no assignments — every percentage on the dashboard divides by these, so the page would be empty');
}

/* ------------------------------------------------------------- events --- */
let orphanEvents = 0, outOfWindow = 0, negative = 0, badDates = 0;
const activeSeats = new Set();
data.events.forEach((e) => {
  if (!e) return;
  if (!isIso(e.date)) { badDates++; return; }
  const key = e.personId + '|' + e.appId;
  if (!seatKeys.has(key)) { orphanEvents++; return; }
  activeSeats.add(key);
  if (e.date < data.windowStart || e.date > data.windowEnd) outOfWindow++;
  for (const f of ['logins', 'activeMinutes', 'actions']) {
    if (e[f] !== undefined && (!isNum(e[f]) || e[f] < 0)) negative++;
  }
});
if (badDates) err(`${badDates} events have a missing or malformed "date"`);
if (negative) err(`${negative} event fields are negative or non-numeric (logins / activeMinutes / actions)`);
if (orphanEvents) {
  warn(`${orphanEvents} events have no matching assignment and are ignored by the dashboard — ` +
       'usually a stale export, or an email that changed');
}
if (outOfWindow) warn(`${outOfWindow} events fall outside windowStart..windowEnd and will never be shown`);

/* ---------------------------------------------------------- substance --- */
const fidelity = data.fidelity || 'full';
if (fidelity === 'full') {
  const withMinutes = data.events.filter((e) => isNum(e.activeMinutes) && e.activeMinutes > 0).length;
  const withActions = data.events.filter((e) => isNum(e.actions) && e.actions > 0).length;
  if (data.events.length && !withMinutes && !withActions) {
    warn('no event carries activeMinutes or actions, but fidelity is "full" — ' +
         'the "signs in, does nothing" panel cannot mean anything. Set fidelity to "last-active-only".');
  }
}
const neverSeats = [...seatKeys].filter((k) => !activeSeats.has(k)).length;
notes.push(`${data.apps.length} apps · ${data.people.length} people · ${data.assignments.length} seats · ` +
           `${data.events.length} events · fidelity "${fidelity}"`);
notes.push(`${activeSeats.size} seats have activity, ${neverSeats} have none on record`);
if (data.assignments.length && neverSeats === data.assignments.length) {
  warn('no seat has any activity at all — the activity feed is probably not wired up yet');
}

function report() {
  notes.forEach((n) => console.log('      ' + n));
  warnings.forEach((w) => console.log('WARN  ' + w));
  errors.forEach((e) => console.log('FAIL  ' + e));
  console.log(errors.length
    ? `\n${FILE}: ${errors.length} error(s), ${warnings.length} warning(s) — the dashboard will not be correct.`
    : `\n${FILE}: valid${warnings.length ? `, with ${warnings.length} warning(s)` : ''}.`);
}
report();
process.exit(errors.length ? 1 : 0);
