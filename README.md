# NYC Charter School Finder

Find, evaluate and shortlist New York City charter schools on one interactive map, then track applications in one place. Built to the **PRD: NYC Charter School Finder** and verified against its **Evaluation Matrix** (see [Testing & evaluation](#testing--evaluation)).

**What families can do**
- **Map + list, always in sync.** All 436 NYC charter school campuses, clustered at city zoom. Click a pin for a preview card, click a list item to centre its pin.
- **Search and filter in a few taps.** Name / network / neighborhood search, borough, grade level, entry grade, community school district and zip code, combined with removable chips and **Clear all**. Sort by name, distance or next deadline. Every view is a shareable URL.
- **Near me / address search.** Distances from the device location or any NYC address or zip (via NYC Planning GeoSearch).
- **Detail pages.** Overview, admissions (how to apply, eligibility, lottery preferences, key dates, apply link), contact (tap-to-call, email, website, directions), costs and extras, plus data source and last-verified date. Missing facts read **"Not available"**.
- **Save with Google, only when needed.** Browsing never requires an account. **Save** or **My Schools** prompts Google sign-in, then returns you to the same school with the save completed.
- **My Schools.** Shortlist on any device, application status (Researching → Accepted/Declined), private notes (2,000 characters), upcoming deadlines, a calendar file (.ics), a read-only share link, and side-by-side **Compare** (2–4 schools).
- **English / Español** toggle, **CSV export**, phone layout with a list/map toggle and bottom-sheet details.

## Quick start

Requires **Node.js 22.13+**. The server uses Node built-ins only; the front end is a React 19 + TypeScript app bundled by esbuild, so install the build tools once:

```bash
npm install               # React, esbuild, TypeScript (build tools only; the server has no runtime dependencies)
cp .env.example .env      # optional for local use
npm run build             # web/src → public/app/app.js (one minified file, self-hosted)
npm run dev               # http://localhost:3000  (includes a "local developer" sign-in)
npm run dev:web           # in a second terminal: rebuilds the React bundle on every save
npm test                  # API / security / logic tests
npm run typecheck         # TypeScript check of web/src
```

Without a Google Client ID everything works except Google sign-in. `npm run dev` turns on a developer sign-in so you can try saving.

## Google sign-in setup (≈5 minutes)
1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials). Configure the OAuth consent screen if asked (External, app name, your email; no extra scopes).
2. **Create credentials → OAuth client ID → Web application.**
3. Under **Authorized JavaScript origins** add `http://localhost:3000`, `http://localhost`, and your deployed URL (e.g. `https://nyc-charter-school-finder.onrender.com`).
4. Put the Client ID in `GOOGLE_CLIENT_ID`. No client secret is needed: the browser gets a signed ID token, and the server verifies it.
5. Optional: restrict who can sign in with `ALLOWED_EMAILS` / `ALLOWED_DOMAINS`.

## Deploy

### Free demo on Render (full app, Google sign-in included)
1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` creates the web service, a random `SESSION_SECRET`, and asks for your `GOOGLE_CLIENT_ID`.
3. Add the Render URL to your OAuth client's authorized origins.

The free plan sleeps after ~15 minutes idle (the first visit takes ~30–60 s to wake), and saved schools reset when it restarts. For real use, switch the plan to **Starter** and uncomment the `disk:` block so the SQLite database persists.

### Anywhere else
Any host that runs Docker or Node 22 works. Set `NODE_ENV=production`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `TRUST_PROXY=true` behind a proxy, serve over HTTPS, and keep `DB_PATH` on a persistent volume. The Dockerfile runs the seed validator, so a bad seed fails the build.

## Data
`data/seed/schools.json` holds **436 campuses** (one pin per school building/program, the way networks list them: Success Academy 59, Uncommon 25, Achievement First 22, KIPP NYC 19, Ascend 17). It is rebuilt by `scripts/build-campus-seed.py` from independent sources, and every campus records which sources confirm it (`checks`). **Only facts with a source are filled in; everything else is `null` and shows "Not available".**

| Source (pulled 2026-10-17) | Used for |
|---|---|
| NYC Charter School Center FINDER (findnyccharterschools.org, 418 campus pages) | campus list, address, grades, phone, website, apply link |
| Network websites: Success Academy, KIPP NYC, Achievement First, Ascend, Uncommon | authority for their own campuses (they list each elementary, middle and high school; FINDER sometimes merges them) |
| NYSED Charter School Directory (as of 2025-09-02) | state license for each campus: name, authorizer, year opened |
| NYC Planning GeoSearch | confirms every address (same house number and street) and places the pin |
| NYC School Districts (`8ugf-3d8u`) and 2020 NTA (`9nt8-h7nd`) maps | district and neighborhood from the pin, never from a listing |
| NYC DOE 2019–20 School Locations (`wg9x-4ke6`), 2020–21 Demographic Snapshot | DOE code, mission, 2020–21 enrollment where a campus is the same school |
| NYC DOE *How to Enroll in Charter Schools* | deadline rule, lottery preferences, Common Application |

**How the data is validated** (`npm run validate-seed` runs on every start and in the Docker build):
- Every campus must be confirmed by a current listing (FINDER or the network site); 87% are confirmed by two or more independent sources and 80% are matched to a state license.
- Every address must geocode to the *same building* (house number and street, `scripts/geocode_check.py`); the geocoder's first answer was wrong for 9 addresses (e.g. "101 E 150th St" came back as 150 E 150th St), which were re-geocoded or, for 3 new buildings not yet in the city's address file, placed from FINDER and flagged.
- Pins more than 150 m from their confirmed address are moved and flagged (1); listed zip codes that disagree with the address were corrected (7).
- No two campuses may share a name; same-name campuses get their grade range (e.g. "Challenge Preparatory Charter School (Grades 6–8)").
- Listings that disagree with a network's own site are left out and reported (`data/sources/build-report.json`), e.g. FINDER's stale entry for Uncommon Excellence Girls MS at its old address.
- `scripts/reconcile_sources.py` compares the sources side by side; `eval/streets.py` (STR-01) checks every pin lands on the street map.

**Known gaps:** 1 campus left out (Achievement First Legacy MS: no source publishes its grades); Zeta's website could not be read, so Zeta relies on FINDER and the state list; enrollment is 2020–21 and only shown where a campus is the same school as then (37%). Refresh before each admissions season by re-pulling the sources into `data/sources/` and running `python3 scripts/build-campus-seed.py`.

### Street map for the hosted demo
The deployed app uses OpenStreetMap's free street tiles (no key needed) with an Esri satellite switch. The single-page demo (`demo/index.html`, for hosts that block outside map images) instead draws its own Google-style street map in the browser (`public/js/streets.js`) from `data/basemap/streets.json` (1.2 MB): 110,559 street segments from NYC Open Data *Centerline* (`inkn-q76z`) merged into 24,058 named lines, 3,308 parks from *Parks Properties* (`enfh-gkve`), 14 cemeteries from *2020 NTAs* (`9nt8-h7nd`) and the shoreline from *Borough Boundaries* (`gthc-hcne`), all pulled 2026-10-17. Highways are yellow from zoom 10, main roads white from 12, all streets from 14, and names show from 16. `npm run build-demo` rebuilds the data (`scripts/build-streets.js` formats names like "W 42nd St") and the page.

## Security
| Area | Implementation |
|---|---|
| Authentication | Google ID token verified server-side (RS256 signature against Google's JWKS, issuer, audience, expiry, `email_verified`) plus a one-time nonce bound to the browser, so replayed tokens are rejected |
| Sessions | Random 256-bit id, HMAC-signed, `HttpOnly` + `SameSite=Lax` (+ `Secure`, HSTS in production); new id at every login; idle and absolute expiry; destroyed on sign-out |
| Authorization | Every saved-school query is scoped to the session's user; user ids are never accepted from the browser |
| Input / output | Validated ids, statuses and note length; all SQL uses prepared statements; all rendered data HTML-escaped; CSV formula injection neutralized |
| Web | CSRF check (same Origin + custom header) on every state change; strict CSP (no inline script, Leaflet self-hosted); `X-Frame-Options`, `nosniff`, Referrer/Permissions-Policy; rate limits on auth, API, events and geocoding; 16 KB body cap |
| Privacy | Only name, email and photo are stored from Google; no PII in URLs (location is never put in the address bar) or logs; share links are random tokens that expose no name, email or notes; analytics events go only to the app's own table |

## Architecture
```
server.js            entry point (Node 22 built-ins only: http, crypto, zlib, node:sqlite)
src/app.js           routes: pages, auth, schools, saved schools/tracker, share, events, geocode, .ics
src/db.js            SQLite schema (schools, school_admissions, school_contact_costs, users, saved_schools, events)
src/seed.js          seed validator (also scripts/validate-seed.js)
src/google.js        Google ID-token verification      src/session.js   sessions + one-time nonces
src/security.js      headers, CSRF, rate limiting       src/events.js    analytics event schema
src/geocode.js       address/zip search                 src/ics.js       iCalendar export
web/src/              React 19 + TypeScript front end (bundled by scripts/build-web.js into public/app/app.js)
  App.tsx              state, URL sync, sign-in flow, keyboard shortcuts    TopBar.tsx   header, account menu
  Sidebar.tsx          search, filters, chips, results list (renders progressively)
  MapView.tsx          Leaflet map, pins/clusters, map/satellite switch     Detail.tsx   school detail panel
  MySchools.tsx        shortlist, tracker, deadlines, share link            Dialogs.tsx  Google sign-in, compare
  lib.ts / types.ts    API client (CSRF header), formatting, shared types
public/js/core.js    filter/sort/search/CSV logic (shared by React and the Node tests)   public/js/cluster.js  pin clustering
public/js/i18n.js    English + Spanish strings          public/js/streets.js  in-browser street map (demo only)
public/vendor/leaflet  Leaflet 1.9.4 built from source (BSD-2)          views/  HTML shells
```
The Docker build has two stages: the first installs the build tools and bundles the React app, the second is the dependency-free server.

### API
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/schools`, `/api/schools/:id` | – | list (compact) and full detail |
| GET | `/api/geocode?q=` | – | address / zip → coordinates |
| POST | `/api/events` | – | client analytics (search, view, outbound, login prompt) |
| GET | `/api/me` | – | current user or `null` |
| GET | `/api/saved`, `/api/saved.ics` | ✓ | shortlist, calendar export |
| PUT / PATCH / DELETE | `/api/saved/:id` | ✓ | save, update status/note, remove |
| GET / POST / DELETE | `/api/share` | ✓ | read-only share link |
| GET | `/api/share/:token` | – | public read-only shortlist |
| GET / POST | `/auth/config`, `/auth/google`, `/auth/logout` | – | sign-in flow |

## Testing & evaluation
- `npm test`: 40 Node tests covering auth (forged, expired, wrong-audience and replayed tokens), sessions, per-user isolation, input safety, CSRF/headers/rate limits, secrets scan, filters and sorting, favorites, tracker, calendar, sharing, events, seed validation and i18n completeness.
- `npm run e2e`: Playwright harness (`eval/e2e.py`) that runs every Evaluation Matrix row in Chromium at 360/390/768/1440 px, writing `eval/results.json` and screenshots. It uses a fixture copy of the seed and local stand-ins for Google's key server and the geocoder, since the test sandbox can't reach Google.

- `python3 eval/streets.py`: the 9 street-map rows (STR-01–09) against the demo build and the full app, including a rerun of the whole suite (`eval/streets-results.json`, screenshots in `eval/screens-streets/`).

**Latest run: 37/37 P0 rows, 8/8 P1 rows and 9/9 street-map rows pass.**
