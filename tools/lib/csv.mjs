/**
 * A small, dependency-free CSV reader aimed at admin-console exports.
 *
 * Handles the things those exports actually do: a UTF-8 BOM, CRLF endings,
 * quoted fields containing commas or newlines, doubled quotes as an escape,
 * and the semicolon or tab delimiters that European and Excel exports use.
 */

/** Guess the delimiter from the header line, outside of quotes. */
function sniffDelimiter(text) {
  let line = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && (c === '\n' || c === '\r')) break;
    line += c;
  }
  const counts = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Parse CSV text into an array of string[] rows. */
export function parseRows(text, delimiter) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // strip BOM
  const d = delimiter || sniffDelimiter(text);
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // "" -> literal quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === d) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // drop trailing blank lines
  while (rows.length && rows[rows.length - 1].every((v) => v.trim() === '')) rows.pop();
  return rows;
}

/** Parse CSV text into objects keyed by header, plus the header list. */
export function parseCsv(text, delimiter) {
  const rows = parseRows(text, delimiter);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = (r[i] === undefined ? '' : r[i]).trim(); });
      return o;
    });
  return { headers, records };
}

/** Normalise a header for fuzzy matching: lowercase, alphanumerics only. */
export const normalizeHeader = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find the header that best matches a list of candidate names.
 * Exact normalised match wins; otherwise the first containment match.
 */
export function findColumn(headers, candidates) {
  const norm = headers.map((h) => [h, normalizeHeader(h)]);
  for (const cand of candidates) {
    const c = normalizeHeader(cand);
    const exact = norm.find(([, n]) => n === c);
    if (exact) return exact[0];
  }
  for (const cand of candidates) {
    const c = normalizeHeader(cand);
    const partial = norm.find(([, n]) => n.includes(c));
    if (partial) return partial[0];
  }
  return null;
}

/**
 * Parse the date formats these exports emit, returning YYYY-MM-DD or null.
 * Ambiguous numeric dates are read as the explicit format when the day
 * exceeds 12; otherwise the caller's dayFirst preference decides.
 */
export function parseDate(value, dayFirst) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || /^(never|n\/?a|none|-|—)$/i.test(s)) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                       // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  if (/^\d{10}$/.test(s)) return new Date(+s * 1000).toISOString().slice(0, 10);   // unix s
  if (/^\d{13}$/.test(s)) return new Date(+s).toISOString().slice(0, 10);          // unix ms

  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);           // d/m/Y or m/d/Y
  if (m) {
    let a = +m[1], b = +m[2];
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : dayFirst ? [a, b] : [b, a];
    return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const t = Date.parse(s);                                            // "12 Jan 2026", RFC
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

/** Parse a number, tolerating thousands separators, blanks and "1h 20m". */
export function parseNumber(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (!s) return 0;
  const hm = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i);
  if (hm && (hm[1] || hm[2])) return (+(hm[1] || 0)) * 60 + (+(hm[2] || 0));
  const n = Number(s.replace(/[\s,_]/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
