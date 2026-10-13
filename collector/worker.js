/**
 * Adoption collector: a Cloudflare Worker backed by a D1 database.
 *
 *   POST /e       a bonus app reports an event (public, allow-listed origins)
 *   GET  /stats   aggregated numbers for the dashboard (needs ADMIN_KEY)
 *
 * What is stored: app, event type, feature label, an anonymous per-browser id,
 * and the server timestamp. Not stored: IP address, user agent, email, or
 * anything the visitor typed.
 *
 * Counts are indicative, not tamper-proof: /e accepts requests from the open
 * internet. The app allow-list, the origin check and the per-visitor daily cap
 * stop casual noise, but a determined person can still forge events.
 */

export const APPS = [
  'landed', 'clientbridge', 'bridgekit', 'dispatch', 'voiced',
  'backlot', 'clipmath', 'bridgekeeper', 'chair', 'shelfwise',
];
const DOMAIN = 'misanmorrison.com';
const TYPES = new Set(['unlock', 'open', 'use']);
const VID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_BODY = 1024;
const MAX_EVENTS_PER_VID_PER_DAY = 200;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

/** Which origins may post events for which app. */
function originAllowed(origin, app, env) {
  if (!origin) return false;
  if (origin === `https://${app}.${DOMAIN}`) return true;
  const extra = String(env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

/** Constant-time string comparison, so the key cannot be guessed by timing. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const cleanFeature = (s) => {
  if (typeof s !== 'string') return null;
  const t = s.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return t || null;
};

async function recordEvent(request, env) {
  const origin = request.headers.get('origin');
  const cors = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413, cors);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400, cors); }

  const { app, type, vid } = body || {};
  if (!APPS.includes(app)) return json({ error: 'unknown app' }, 400, cors);
  if (!TYPES.has(type)) return json({ error: 'unknown type' }, 400, cors);
  if (typeof vid !== 'string' || !VID.test(vid)) return json({ error: 'bad vid' }, 400, cors);
  if (!originAllowed(origin, app, env)) return json({ error: 'origin not allowed' }, 403);

  const now = new Date();
  const ts = now.toISOString();
  const day = ts.slice(0, 10);

  // Per-visitor daily cap: beyond it we accept the request but store nothing.
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE vid = ? AND day = ?')
    .bind(vid, day).first();
  if (used && used.n >= MAX_EVENTS_PER_VID_PER_DAY) return new Response(null, { status: 204, headers: cors });

  await env.DB.prepare('INSERT INTO events (ts, day, app, type, feature, vid) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ts, day, app, type, type === 'use' ? cleanFeature(body.feature) : null, vid).run();
  return new Response(null, { status: 204, headers: cors });
}

async function stats(request, env) {
  const auth = request.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // The dashboard is served from another origin, so even the 401 must carry the CORS header,
  // otherwise the browser hides it and a wrong key looks like "could not reach the server".
  if (!env.ADMIN_KEY || !safeEqual(key, env.ADMIN_KEY)) {
    return json({ error: 'unauthorized' }, 401, { 'access-control-allow-origin': '*' });
  }

  const url = new URL(request.url);
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const since7 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);

  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results || []);

  const [totals, returning, active7, features, daily, firstSeen] = await Promise.all([
    q(`SELECT app,
              SUM(type = 'unlock') AS unlocks,
              SUM(type = 'open')   AS opens,
              SUM(type = 'use')    AS uses,
              COUNT(DISTINCT vid)  AS visitors,
              MAX(ts)              AS lastSeen
         FROM events WHERE day >= ? GROUP BY app`, since),
    q(`SELECT app, COUNT(*) AS n FROM (
         SELECT app, vid FROM events WHERE day >= ? GROUP BY app, vid HAVING COUNT(DISTINCT day) > 1
       ) GROUP BY app`, since),
    q(`SELECT app, COUNT(DISTINCT vid) AS n FROM events WHERE day >= ? GROUP BY app`, since7),
    q(`SELECT app, feature, COUNT(*) AS n FROM events
        WHERE day >= ? AND type = 'use' AND feature IS NOT NULL
        GROUP BY app, feature ORDER BY n DESC`, since),
    q(`SELECT app, day, COUNT(DISTINCT vid) AS visitors, COUNT(*) AS events
         FROM events WHERE day >= ? GROUP BY app, day ORDER BY day`, since),
    q(`SELECT app, MIN(ts) AS firstSeen FROM events GROUP BY app`),
  ]);

  const by = (rows) => Object.fromEntries(rows.map((r) => [r.app, r]));
  const T = by(totals), R = by(returning), A = by(active7), F = by(firstSeen);
  const out = APPS.map((app) => ({
    app,
    unlocks: T[app]?.unlocks || 0,
    opens: T[app]?.opens || 0,
    uses: T[app]?.uses || 0,
    visitors: T[app]?.visitors || 0,
    returning: R[app]?.n || 0,
    active7: A[app]?.n || 0,
    lastSeen: T[app]?.lastSeen || null,
    firstSeen: F[app]?.firstSeen || null,
    features: features.filter((f) => f.app === app).map((f) => ({ feature: f.feature, count: f.n })),
    daily: daily.filter((d) => d.app === app).map((d) => ({ day: d.day, visitors: d.visitors, events: d.events })),
  }));
  return json({ days, since, generatedAt: new Date().toISOString(), apps: out }, 200, {
    'access-control-allow-origin': '*',
  });
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');

  if (request.method === 'OPTIONS') {
    // Preflight: the tracker avoids one by using a simple request, but answer anyway.
    const ok = origin && (APPS.some((a) => originAllowed(origin, a, env)) || url.pathname === '/stats');
    return new Response(null, {
      status: ok ? 204 : 403,
      headers: ok ? {
        'access-control-allow-origin': url.pathname === '/stats' ? '*' : origin,
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '86400',
        vary: 'origin',
      } : {},
    });
  }
  if (url.pathname === '/e' && request.method === 'POST') return recordEvent(request, env);
  if (url.pathname === '/stats' && request.method === 'GET') return stats(request, env);
  if (url.pathname === '/' && request.method === 'GET') return json({ ok: true, service: 'adoption-collector' });
  return json({ error: 'not found' }, 404);
}

export default { fetch: (request, env) => handle(request, env) };
