# App adoption dashboard

A single-page dashboard that answers one question: **are people actually signing
in and using the apps we pay for?**

It separates three things that usually get lumped together:

| | means |
|---|---|
| **Has a seat** | we are paying for a licence |
| **Signs in** | an SSO session gets opened |
| **Really uses it** | sessions are long enough and busy enough to be real work |

The gap between the second and third is the thing most adoption reports miss, so
it gets its own tile: **"Signs in, does nothing."**

Ships with a seeded demo dataset (9 apps, 41 people, 120 days) so you can open it
and see the whole thing working before wiring up a real source.

![Dashboard](docs/preview.png)

## Running it

Double-click `index.html`. That is the whole install.

It reads `data/usage.json` over `fetch()` when served over HTTP, and falls back
to `data/usage.js` (the same payload as a plain script) so it also works from
`file://`, where `fetch()` is blocked by CORS. To serve it properly:

```sh
python3 -m http.server 8000     # then open http://localhost:8000/
```

No build step, no dependencies, no CDN — the page is self-contained apart from
its data file.

## What's on it

| Panel | Question it answers |
|---|---|
| Real adoption (hero) | what share of the seats we pay for are genuinely in use |
| Stat tiles | who never showed up, who went quiet, who signs in and does nothing, what it costs |
| Seats used vs seats paid for | which apps are over-licensed, per app |
| Engagement mix | how each app's seats break down across the five tiers |
| Daily active people | is usage trending up, down, or flat |
| Who uses what | the per-person, per-app grid — who is dark on which app |
| Seats worth reclaiming | the actionable list, sorted by monthly cost |
| People | per-person summary and last sign-in |

Filters for date range, team and app sit in one row and scope every panel below
them, so the numbers always agree. Every chart has a table view, full keyboard
support, and a dark mode.

## The engagement model

A **seat** is one (person, app) assignment. Each seat lands in exactly one tier
for the selected range:

| Tier | Definition |
|---|---|
| **Never signed in** | no sign-in ever recorded, in any range |
| **Gone quiet** | signed in at some point, nothing inside this range |
| **Light** | active on under a quarter of the working days available to it |
| **Regular** | active on a quarter to six-tenths of those days |
| **Power** | active on 60%+ of those days |

Two details that keep the numbers honest:

- **Seats are judged over the working days they actually had.** Someone who
  joined last week is not scored as "dormant for 90 days" — the denominator is
  the working days since the later of their start date and the seat assignment.
- **"Signs in, does nothing" is a flag, not a tier.** A seat is flagged when it
  has at least two sign-ins averaging under 5 minutes and under 3 meaningful
  actions each. It still counts in whatever tier its activity rate earns, so the
  tiers stay a clean partition and nothing is double-counted.

Both thresholds are constants at the top of the script
(`LOGIN_ONLY_MAX_MINUTES`, `LOGIN_ONLY_MAX_ACTIONS`), and the tier cutoffs live
in `tierFor()`. Tune them to your tools — a design tool and a payroll tool have
very different "normal."

## Replacing the demo data

`data/usage.json` is the contract. Emit this shape from wherever your real data
lives and nothing in `index.html` changes:

```jsonc
{
  "windowStart": "2026-05-25",     // first date covered
  "windowEnd":   "2026-09-21",     // last date covered; "today" for the dashboard
  "currency":    "USD",

  "apps": [
    { "id": "slack", "name": "Slack", "category": "Communication",
      "seatCostMonthly": 8.75 }
  ],

  "people": [
    { "id": "u01", "name": "Ana Alves", "email": "ana@example.com",
      "team": "Engineering", "joinedAt": "2026-05-25" }
  ],

  // one row per licence you are paying for
  "assignments": [
    { "personId": "u01", "appId": "slack", "assignedAt": "2026-05-25" }
  ],

  // daily rollup, one row per person per app per active day.
  // A day with no row means no activity — absence of a row is absence of a login.
  "events": [
    { "personId": "u01", "appId": "slack", "date": "2026-09-20",
      "logins": 3, "activeMinutes": 145, "actions": 62 }
  ]
}
```

Notes on the fields that carry weight:

- **`assignments` is the denominator for everything.** A person with no
  assignment row for an app simply has no seat there (the grid shows an outlined
  cell); they are never counted as a non-adopter.
- **`activeMinutes` and `actions` are what separate "logged in" from "used."**
  If your source only gives you sign-ins, set them from whatever proxy you have
  and loosen the two thresholds — but the "signs in, does nothing" tile is only
  as good as these two numbers.
- Events without a matching assignment are ignored, so a stale export won't
  inflate adoption.

### Where to get the real numbers

- **Sign-ins** — the identity provider's audit log is the reliable source: Okta
  System Log, Entra ID sign-in logs, or Google Workspace Login Audit.
- **In-app activity** — per-app admin analytics or SCIM/usage APIs. This is the
  part no single source gives you; expect one small fetcher per app.
- **Seat assignments and cost** — the identity provider's app assignments, or
  the billing export from each vendor.

Write whichever of these you have into the shape above; the dashboard degrades
gracefully as long as `assignments` is complete.

## Regenerating the demo data

```sh
node tools/generate-data.mjs              # rewrites data/usage.json + data/usage.js
node tools/generate-data.mjs --days 180   # longer history
```

The generator is seeded, so output is reproducible. It deliberately plants the
patterns the dashboard exists to catch: engineers holding unused Salesforce
seats, a tail of licences nobody ever opened, seats that went quiet after
onboarding, and a set of people who open the app and do nothing.

## Layout

```
index.html                 the dashboard — markup, styles and logic, no dependencies
data/usage.json            the dataset (the contract above)
data/usage.js              same payload as a script, for file:// use
tools/generate-data.mjs    seeded demo-data generator
```

## Design notes

Colour is doing real work here, so it follows a few rules worth keeping if you
restyle it:

- **Nine apps never become nine colours.** Per-app comparison uses one hue and
  bar length; the person/app grid uses a single-hue sequential ramp. Generated
  hues past the eighth are indistinguishable under colour-vision deficiency.
- **Engagement tiers use an ordinal single-hue ramp**, light to dark, so "more
  usage" reads as "darker" rather than as an arbitrary palette. Both the light
  and dark ramps were checked for monotone lightness, per-step separation and
  contrast against their own surface.
- **Status colours are reserved** for never / quiet / login-only and always ship
  with an icon and a text label, never colour alone.
- Every chart has a table twin, and keyboard focus surfaces the same readout as
  hover, so nothing is gated behind a mouse.
