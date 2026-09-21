/**
 * Generates the seeded demo dataset for the adoption dashboard.
 *
 *   node tools/generate-data.mjs            # writes data/usage.json + data/usage.js
 *   node tools/generate-data.mjs --days 180 # longer history
 *
 * The output format is the contract the dashboard reads. Replace this generator
 * with a real export/ingest that emits the same shape and nothing in index.html
 * needs to change. See README.md for the schema.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = Number(process.argv[process.argv.indexOf('--days') + 1]) || 120;
const END = new Date('2026-09-21T00:00:00Z'); // last full day in the dataset

/* Deterministic PRNG so regenerating gives byte-identical output. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260921);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);
const intBetween = (lo, hi) => Math.floor(between(lo, hi + 1));

const dayISO = (i) => {
  const d = new Date(END);
  d.setUTCDate(d.getUTCDate() - (DAYS - 1 - i));
  return d.toISOString().slice(0, 10);
};

/* ---------------------------------------------------------------- apps --- */

const apps = [
  { id: 'slack',      name: 'Slack',      category: 'Communication',   seatCostMonthly: 8.75,  sso: true },
  { id: 'zoom',       name: 'Zoom',       category: 'Meetings',        seatCostMonthly: 15.99, sso: true },
  { id: 'notion',     name: 'Notion',     category: 'Docs & wiki',     seatCostMonthly: 10.0,  sso: true },
  { id: 'github',     name: 'GitHub',     category: 'Engineering',     seatCostMonthly: 21.0,  sso: true },
  { id: 'jira',       name: 'Jira',       category: 'Project tracking',seatCostMonthly: 8.15,  sso: true },
  { id: 'figma',      name: 'Figma',      category: 'Design',          seatCostMonthly: 15.0,  sso: true },
  { id: 'salesforce', name: 'Salesforce', category: 'CRM',             seatCostMonthly: 165.0, sso: true },
  { id: 'hubspot',    name: 'HubSpot',    category: 'Marketing',       seatCostMonthly: 45.0,  sso: false },
  { id: 'asana',      name: 'Asana',      category: 'Project tracking',seatCostMonthly: 13.49, sso: false },
];

/* -------------------------------------------------------------- people --- */

const FIRST = ['Ana','Bruno','Carla','Diego','Elena','Farid','Gabi','Hugo','Ines','Jonas','Kira','Luca',
  'Mara','Nuno','Olga','Pedro','Quinn','Rita','Sami','Tomas','Uma','Vera','Wes','Xenia','Yannis','Zoe',
  'Alex','Bea','Caio','Dina','Emil','Fay','Gus','Hana','Ivo','June','Karl','Lia','Mio','Nils','Oona','Petra'];
const LAST = ['Alves','Bauer','Costa','Duarte','Erikson','Ferreira','Gomes','Haas','Iversen','Jansen',
  'Kovac','Lima','Moreau','Novak','Oliveira','Pinto','Quaresma','Ribeiro','Silva','Tavares','Ulrich',
  'Vieira','Wolf','Xavier','Yilmaz','Zanetti','Abreu','Brandt','Cardoso','Dias','Engel','Faria','Graf',
  'Horta','Ito','Jorge','Klein','Lopes','Matos','Nunes','Ortiz','Pires'];

const TEAMS = [
  { name: 'Engineering', n: 13 },
  { name: 'Design',      n: 5  },
  { name: 'Sales',       n: 8  },
  { name: 'Marketing',   n: 5  },
  { name: 'Operations',  n: 6  },
  { name: 'Leadership',  n: 4  },
];

const people = [];
let idx = 0;
for (const team of TEAMS) {
  for (let i = 0; i < team.n; i++) {
    const first = FIRST[idx % FIRST.length];
    const last = LAST[(idx * 7 + 3) % LAST.length];
    // A few people joined part-way through the window - their "no activity on
    // day 1" is legitimate, and the dashboard must not score them as dormant.
    const joinedDayIndex = rnd() < 0.12 ? intBetween(15, DAYS - 25) : 0;
    people.push({
      id: `u${String(idx + 1).padStart(2, '0')}`,
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      team: team.name,
      joinedAt: dayISO(joinedDayIndex),
      _joined: joinedDayIndex,
    });
    idx++;
  }
}

/* --------------------------------------------------------- assignments --- */

/* Which apps a team is licensed for. Some of these are deliberately generous -
   that over-provisioning is exactly what the dashboard is built to surface. */
const TEAM_APPS = {
  Engineering: ['slack','zoom','notion','github','jira','figma','asana'],
  Design:      ['slack','zoom','notion','figma','jira','asana'],
  Sales:       ['slack','zoom','notion','salesforce','hubspot','asana'],
  Marketing:   ['slack','zoom','notion','hubspot','figma','asana','salesforce'],
  Operations:  ['slack','zoom','notion','jira','asana','salesforce','hubspot'],
  Leadership:  ['slack','zoom','notion','salesforce','hubspot','jira','github','figma','asana'],
};

/* How engaged a team tends to be with an app: the mean of the draw that picks a
   behaviour archetype. Low numbers => more never/lapsed seats. */
const AFFINITY = {
  slack: 0.95, zoom: 0.85, notion: 0.72, github: 0.9, jira: 0.7,
  figma: 0.8, salesforce: 0.55, hubspot: 0.5, asana: 0.38,
};
const TEAM_FIT = {
  Engineering: { salesforce: 0.05, hubspot: 0.08, figma: 0.35, asana: 0.25 },
  Design:      { jira: 0.45, asana: 0.4 },
  Sales:       { notion: 0.5, asana: 0.3 },
  Marketing:   { figma: 0.45, salesforce: 0.3, asana: 0.35 },
  Operations:  { salesforce: 0.35, hubspot: 0.3, jira: 0.5 },
  Leadership:  { github: 0.1, figma: 0.12, jira: 0.3, asana: 0.2 },
};

const ARCHETYPES = ['power','regular','light','loginOnly','lapsed','never'];

function archetypeFor(person, appId) {
  const base = AFFINITY[appId];
  const fit = TEAM_FIT[person.team]?.[appId];
  const score = fit === undefined ? base : (base + fit * 2) / 3;
  const r = rnd();
  // score high -> weight toward power/regular; score low -> toward never/lapsed
  if (r < score * 0.34) return 'power';
  if (r < score * 0.70) return 'regular';
  if (r < score * 0.88) return 'light';
  if (r < score * 0.88 + 0.07) return 'loginOnly';
  if (r < score * 0.88 + 0.07 + (1 - score) * 0.45) return 'lapsed';
  return 'never';
}

const assignments = [];
for (const p of people) {
  for (const appId of TEAM_APPS[p.team]) {
    assignments.push({
      personId: p.id,
      appId,
      assignedAt: dayISO(Math.min(p._joined + (p._joined ? 1 : 0), DAYS - 1)),
      _arch: archetypeFor(p, appId),
    });
  }
}

/* -------------------------------------------------------------- events --- */

/* Daily per-person-per-app rollup. A day with no row means no activity at all -
   which is the whole point: absence of a row is absence of a login. */

const isWeekend = (i) => {
  const d = new Date(END);
  d.setUTCDate(d.getUTCDate() - (DAYS - 1 - i));
  const w = d.getUTCDay();
  return w === 0 || w === 6;
};

const PROFILE = {
  power:     { pWeekday: 0.86, pWeekend: 0.18, logins: [2, 6], minutes: [45, 240], perLogin: [8, 30] },
  regular:   { pWeekday: 0.52, pWeekend: 0.06, logins: [1, 3], minutes: [15, 90],  perLogin: [5, 18] },
  light:     { pWeekday: 0.16, pWeekend: 0.02, logins: [1, 2], minutes: [5, 30],   perLogin: [2, 9]  },
  // The signal the dashboard exists to catch: SSO session opens, nothing happens.
  loginOnly: { pWeekday: 0.30, pWeekend: 0.02, logins: [1, 2], minutes: [1, 4],    perLogin: [0, 2]  },
};

const events = [];
for (const a of assignments) {
  const person = people.find((p) => p.id === a.personId);
  const start = Math.max(person._joined, 0);
  if (a._arch === 'never') continue;

  let profile, from = start, to = DAYS;
  if (a._arch === 'lapsed') {
    // Used it for a while after onboarding, then stopped. Stop date lands well
    // before the end so a 30-day window reads it as dormant.
    profile = PROFILE[pick(['regular', 'light', 'light'])];
    to = Math.min(DAYS, start + intBetween(12, Math.max(14, DAYS - 45)));
  } else {
    profile = PROFILE[a._arch];
  }

  // Per-seat intensity so two "regular" seats don't look identical.
  const jitter = between(0.7, 1.3);

  for (let d = from; d < to; d++) {
    const p = (isWeekend(d) ? profile.pWeekend : profile.pWeekday) * jitter;
    if (rnd() > p) continue;
    const logins = intBetween(profile.logins[0], profile.logins[1]);
    const minutes = Math.round(between(profile.minutes[0], profile.minutes[1]) * jitter);
    const actions = Math.round(logins * between(profile.perLogin[0], profile.perLogin[1]));
    events.push({
      personId: a.personId,
      appId: a.appId,
      date: dayISO(d),
      logins,
      activeMinutes: Math.max(1, minutes),
      actions,
    });
  }
}

events.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

/* -------------------------------------------------------------- output --- */

const payload = {
  generatedAt: new Date().toISOString(),
  windowStart: dayISO(0),
  windowEnd: dayISO(DAYS - 1),
  days: DAYS,
  currency: 'USD',
  apps,
  people: people.map(({ _joined, ...p }) => p),
  assignments: assignments.map(({ _arch, ...a }) => a),
  events,
};

mkdirSync(join(ROOT, 'data'), { recursive: true });
const json = JSON.stringify(payload);
writeFileSync(join(ROOT, 'data', 'usage.json'), json + '\n');
// Same payload as a plain script, so index.html also works from file:// where
// fetch() is blocked by CORS. The dashboard prefers the .json and falls back.
writeFileSync(
  join(ROOT, 'data', 'usage.js'),
  '/* Generated by tools/generate-data.mjs - do not edit. Mirrors usage.json. */\n' +
    'window.USAGE_DATA = ' + json + ';\n'
);

const counts = assignments.reduce((m, a) => ((m[a._arch] = (m[a._arch] || 0) + 1), m), {});
console.log(`people=${people.length} apps=${apps.length} seats=${assignments.length} events=${events.length}`);
console.log('seat archetypes:', counts);
console.log(`wrote data/usage.json (${(json.length / 1024).toFixed(0)} KB) and data/usage.js`);
