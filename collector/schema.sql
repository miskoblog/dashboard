-- Events collected from the 10 bonus apps. One row per event; no IP address,
-- no user agent, no email: only an anonymous random browser id (vid).
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,           -- server time, ISO-8601 UTC
  day     TEXT NOT NULL,           -- YYYY-MM-DD, derived from ts
  app     TEXT NOT NULL,           -- one of the allow-listed app slugs
  type    TEXT NOT NULL,           -- unlock | open | use
  feature TEXT,                    -- tab or button label for type = use
  vid     TEXT NOT NULL            -- anonymous per-browser id
);
CREATE INDEX IF NOT EXISTS idx_events_app_day ON events (app, day);
CREATE INDEX IF NOT EXISTS idx_events_vid_day ON events (vid, day);
