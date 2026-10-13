# Adoption collector

Receives "someone unlocked this app" and "someone used a feature" events from the
ten bonus apps, stores them, and serves the totals to the dashboard.

```
bonus app  --(tracker/track.js)-->  POST /e      \
                                                  >  Cloudflare Worker + D1 database
dashboard  <------------------      GET  /stats  /
```

**Stored:** app, event type, feature label, an anonymous random browser id, server time.
**Never stored:** IP address, user agent, email, or anything a visitor typed.

## Check it works (no account needed)

```sh
cd collector && npm test
```

Runs the Worker's real SQL against SQLite (the engine D1 uses) through a small adapter.

## Deploy it

> The commands below are from memory of Cloudflare's tooling and were **not** run
> against a real account, because this was built without one. If a command or menu
> has changed, Cloudflare's current Workers and D1 docs win.

### Option A: with the command line (needs Node)

```sh
cd collector
npx wrangler login
npx wrangler d1 create adoption            # prints a database_id
# paste that id into wrangler.toml, replacing REPLACE_WITH_ID_FROM_wrangler_d1_create
npx wrangler d1 execute adoption --remote --file=schema.sql
npx wrangler secret put ADMIN_KEY          # choose a long random string; keep it
npx wrangler deploy                        # prints https://adoption-collector.<you>.workers.dev
```

### Option B: in the Cloudflare dashboard (no command line)

1. Workers & Pages -> Create -> Worker. Paste in the contents of `worker.js`. Deploy.
2. Storage & Databases -> D1 -> Create database, named `adoption`. In its Console tab,
   paste and run `schema.sql`.
3. Back on the Worker -> Settings -> Bindings -> add a D1 binding named exactly `DB`
   pointing at `adoption`.
4. Worker -> Settings -> Variables and Secrets -> add a **secret** named `ADMIN_KEY`.

Your DNS can stay at Namecheap. The Worker lives at its own `*.workers.dev` address.

### Then

Open `https://<your-worker>.workers.dev/` : it should answer `{"ok":true,...}`.
Send that address to whoever is installing the tracker, and keep `ADMIN_KEY` for the
dashboard. Never commit `ADMIN_KEY` anywhere.

## The apps it accepts

`landed clientbridge bridgekit dispatch voiced backlot clipmath bridgekeeper chair shelfwise`,
each only from its own `https://<app>.misanmorrison.com`. Adding an eleventh app means
adding its slug to `APPS` in `worker.js` and redeploying.

## Limits

Counts are **indicative, not tamper-proof**. `/e` is open to the internet, so the app
allow-list, origin check and 200-events-per-visitor-per-day cap stop noise, not a
determined person forging events. Browsers that send Do Not Track or Global Privacy
Control are not counted at all, and a visitor who clears their browser data becomes a
new visitor.

"Login" here means opening the shared-password gate. The apps have no individual
accounts, so this counts anonymous browsers, not people.
