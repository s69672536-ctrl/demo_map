# Puthusu — Field Collection Route System

A fixed-sequence route system for field collection agents (microfinance,
bill/loan collection, meter reading style work) — not an on-demand routing
app. A manager builds each route once (optimized via OSRM), and every
collector who runs that route follows the same numbered stop list.

## What's in here

```
backend/            FastAPI + SQLAlchemy + PostgreSQL (SQLite by default for easy local testing)
admin_dashboard/     Plain HTML/JS + Leaflet map for building & assigning routes (manager-facing)
collector_web/        Plain HTML/JS mobile-friendly app for collectors - shows today's ordered stops
```

Everything except the backend is plain HTML/CSS/JS — no build step, no
Node.js, no framework. Open the files in a browser and they work.

## How it fits together

1. **Admin dashboard** — manager clicks a start point, an end point, then
   drops pins for each customer. Clicking "Optimize Route" calls the backend,
   which calls OSRM's Trip service once and saves the result as each
   customer's fixed `sequence` number. Manager also creates collectors and
   assigns them to a route for a given day.
2. **Backend** — owns the routes/customers/sequence, the daily
   collected/skipped/pending status per stop, collector assignments (so a
   substitute can take over someone's exact route), and live GPS pings.
3. **Collector web app** — collector opens the page on their phone's
   browser, logs in with their phone number, and gets the ordered stop list
   for whichever route they're assigned to today. They never choose the
   order — the app just tells them, and they tap through Paid / Skip /
   Absent as they go.

## Running the backend

```bash
cd backend
python3 -m venv venv && source venv/bin/activate    # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # defaults to a local SQLite file, no setup needed
uvicorn app.main:app --reload
```

Visit `http://localhost:8000/docs` for interactive API docs — you can create
routes, customers, and collectors by hand here to test things before wiring
up the UIs.

To use real Postgres instead of the SQLite default, create a database and
set `DATABASE_URL` in `.env`, e.g.:

```
DATABASE_URL=postgresql://vrp_user:vrp_password@localhost:5432/vrp_collection
```

### Route optimization (OSRM)

`.env` defaults to the public OSRM demo server
(`https://router.project-osrm.org`), which is fine for trying things out but
is rate-limited and not meant for production. For real use, self-host OSRM
with your country's road network (see http://project-osrm.org/) and point
`OSRM_BASE_URL` at it.

## Running the admin dashboard (manager)

Static files, no build step. With the backend running:

```bash
cd admin_dashboard
python3 -m http.server 8080
```

Open `http://localhost:8080`. Edit `config.js` if your backend isn't on
`http://localhost:8000`.

Workflow:
1. Enter a route name, click the map for start then end point, click **Create Route**.
2. Click the map to drop a customer pin, fill in their name/phone/amount, click **Add Customer**. Repeat for all customers.
3. Click **Optimize Route** — calls OSRM and saves the best visiting order.
4. Create a collector (name + phone), select them, then pick one:
   - **"Assign selected collector (today only)"** — one-off, e.g. a substitute covering for someone absent today.
   - **"Make this their permanent route"** — this collector automatically gets this exact route every single day from now on, with no daily reassignment needed. This is the "one area = one collector" setup (e.g. "Ramesh always does Nungambakkam").

A per-date assignment always overrides the permanent one for that single day, so you can still slot in a substitute without disturbing the regular owner's setup.

## Running the collector web app

Also static files, run on a different port so it doesn't collide with the admin dashboard:

```bash
cd collector_web
python3 -m http.server 8081
```

Open `http://localhost:8081` (or open it on a phone browser pointed at your
machine's LAN IP, e.g. `http://192.168.1.20:8081`, once you update
`config.js` there to match — see below).

Login uses phone number only (see note below) — use the exact phone number
you gave the collector in the admin dashboard.

`config.js` controls where it looks for the backend:
```js
const API_BASE_URL = "http://localhost:8000";
```
If collectors are opening this on their own phones (not the same machine as
the backend), change this to your backend's LAN IP or deployed URL, e.g.
`http://192.168.1.20:8000`.

## Frequently asked behavior

- **Adding a new customer to a route the collector is already running today**
  — no extra step needed. `/collections/today` reads the route's active
  customer list fresh every time it's called, so a customer added mid-day
  shows up the next time the collector taps refresh, with a pending record
  created automatically.
- **"Next stop" highlighting** — the collector web app finds the first
  `pending` stop in sequence and highlights its badge blue; everything
  before it that's marked collected/skipped/absent is green/orange, and
  everything after is grey. This is automatic once a stop is marked done -
  no separate configuration.
- **KM travelled tracking** — the collector web app pings its GPS location
  to the backend every 15 seconds while logged in (`navigator.geolocation`,
  needs the browser's location permission). The admin dashboard's **Live
  Tracking** panel polls `/tracking/summary` every 10 seconds and shows each
  collector's live position (as a blue dot on the map) plus total km
  travelled today, computed by summing straight-line distance between
  consecutive GPS pings (`app/geo.py`). This is "as the crow flies," not
  road distance — accurate enough for a rough travelled-today figure given
  frequent pings, but not turn-by-turn routing distance.
- **Route line on the map** — after clicking **Optimize Route**, the admin
  dashboard draws the actual road-following path (a black line) through the
  route via `GET /routes/{id}/geometry`, which calls OSRM's Route service
  on the already-optimized stop order.
- **Live progress along the route** — the Live Tracking panel also colors
  each collector's route by progress, via `GET /collections/today/geometry`:
  green for the portion already covered (collected/skipped/absent stops),
  a thicker blue dashed segment for the leg they're currently heading
  toward (from their last completed stop to the next pending one), and a
  thin grey dashed line for what's still ahead after that. This updates
  automatically as the collector marks stops done in their app.

## Single-segment navigation (Google-Maps-style)

The collector web app shows **only one destination at a time** — never the
full remaining route:

- `GET /collections/current-leg?collector_id=X` returns just the active
  segment: from wherever the collector last finished (or the route's start,
  if nothing's done yet) to the next pending stop. It includes road-following
  geometry, distance, ETA, the customer's amount due, and their house photo.
- After a stop is marked done, the app calls this endpoint again and
  automatically draws the *next* segment — the collector never has to
  manually advance.
- **Geofence arrival detection**: the app watches GPS continuously
  (`navigator.geolocation.watchPosition`) and shows an "You've arrived" banner
  once the collector is within `GEOFENCE_METERS` (default 45m, see the
  constant at the top of `collector_web/app.js`) of the current destination.
  **This does not auto-mark the stop as paid** — collecting money still
  requires a tap to confirm; the geofence only surfaces the prompt.
- The admin dashboard is unaffected by this — it still shows the *entire*
  permanent route (black line) plus live progress coloring, since managers
  need the full picture even though field collectors don't.

## House photos

- `POST /customers/{id}/house-image` (multipart form upload) attaches a
  photo of the house/shop front, stored under `backend/static/uploads/` and
  served at `/static/uploads/<filename>`.
- The admin dashboard's "Add Customer" form has a file picker that uploads
  the photo right after the customer is created.
- The collector app shows the photo on the current-destination card before
  they arrive, so they can recognize the place.

## Key design decisions (from the original discussion)

- **Sequence is a float with gaps** (10, 20, 30…) so new customers can be
  inserted without renumbering the whole route.
- **Daily status is separate from the route itself** (`collections` table)
  — marking someone as paid/skipped today never touches the fixed sequence,
  so route history and reporting stay clean.
- **Route assignments are per-date**, not baked into the route — if a
  collector is absent, assign the same route to someone else for that day
  and they get the identical stop list.
- **Optimize once, not every morning** — OSRM runs when a route's customer
  list changes, not on every collection day. Collectors always see a stable,
  predictable order.

## What's intentionally left as a stub

- **Auth** — `/collectors/login` just matches by phone number, no
  password/OTP/JWT. Fine for a prototype; replace before production.
- **CORS** — wide open (`allow_origins=["*"]`) for local dev convenience.
- **GPS tracking loop** — the backend has `/tracking/{collector_id}/ping`
  and `/tracking/live` ready to go; the collector web app doesn't call the
  ping endpoint on a timer yet (add a `setInterval` with
  `navigator.geolocation.getCurrentPosition` in `collector_web/app.js` to
  wire it up), and the admin dashboard doesn't yet render a live map layer
  from `/tracking/live`.
- **Recurring day boundary** — the report endpoint takes a `date` — wire up
  a scheduler/cron if you want to auto-generate tomorrow's collection rows.

## Suggested build order

1. Backend + SQLite, confirm `/docs` works, create a route + customers by hand via Swagger.
2. Admin dashboard against the running backend.
3. Collector web app for the ordered list + mark-paid flow.
4. GPS tracking (see stub note above) + a live map view in the admin dashboard.
5. Reporting (`/collections/report` is a starting point — extend per your needs).
6. Swap the phone-only login for real auth before handling real collections.
