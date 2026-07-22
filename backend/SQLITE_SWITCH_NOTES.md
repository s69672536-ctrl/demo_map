# Switched off Postgres, onto local SQLite

## Files changed
- `app/database.py` - now defaults to a local SQLite file
  (`vrp_collection.db`) instead of requiring `DATABASE_URL` to point at
  Postgres. When you later bundle this with PyInstaller, it resolves the
  file's location next to the running .exe (not the temp extraction
  folder), so your data survives restarts.
- `.env` - the Postgres connection string (and its embedded password) is
  removed. `DATABASE_URL` is now commented out entirely, which makes the
  app fall back to the local SQLite file automatically.
- `.env.example` - same idea, documents the SQLite default and shows how
  to opt back into Postgres/SQL Server later if you ever need a shared
  remote database again.
- `requirements.txt` - dropped `psycopg2-binary` (the Postgres driver -
  no longer needed). SQLite support is built into Python already.

## About your Postgres credentials
Your uploaded `.env` had a live Postgres password in plain text
(`collection_xg9d_user:...@...render.com`). I removed it from the file
I'm handing back, but since that database/password already existed and
was shared with me, I'd recommend rotating that password on Render once
you're done migrating off it, just to be safe.

## Your data
`backend/vrp_collection.db` in your upload already has all the right
tables (`routes`, `customers`, `collectors`, `collections`,
`route_assignments`, `collector_locations`) - looks like a local dev copy
that's schema-compatible with the current models. I left it as-is, so
your app should pick up right where that file left off. If you'd rather
start empty, just delete that file - it'll be recreated automatically
(empty) on next run.

## Nothing else changed
No router files, no models, no schema - I checked and there was no
Postgres-specific SQL anywhere in the routers, so this was purely a
connection-string swap.

## What's next (not done yet)
This makes the backend Postgres-free and portable, but it's still a
process you run with `uvicorn app.main:app`. To get to the "one
executable, no manual deployment" goal we talked about, the next step is
packaging this with PyInstaller into a single .exe/binary the admin can
just double-click. Say the word and I'll set that up.
