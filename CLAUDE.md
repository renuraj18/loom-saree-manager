# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The app is branded **My Thari – Track all my loom production** (logo assets in `public/img/`, generated from the transparent `public/Thari Logo.png` by `scripts/build-logo.py`, which needs Pillow). Internal identifiers such as the backup `format: "loom-saree-backup"`, `localStorage` keys (`loom.*`) and the `LOOM_SUPERVISED` env var keep the old name on purpose, so existing data and sessions keep working.

## Commands

```bash
npm install
npm start          # node launcher.js -> runs server.js on 0.0.0.0:$PORT (default 3000), restarting it on exit code 75; `npm run dev` is identical
npm run reset-data # clears every factory's data (keeps factories + users) after a full backup; asks to type RESET
npm run build:win  # dist/MyThari-windows.zip: portable folder with bundled node.exe + .bat launchers
```

CI/CD: `.github/workflows/windows-release.yml` runs on every push to `main` (pushes that only change `*.md` are skipped) and can be started by hand. It runs `npm ci`, `node --check` on every module and `npm run build:win` with `BUILD_NUMBER` = run number, then publishes the GitHub Release `v<package version>-build.<N>` (marked latest) with `MyThari-windows.zip` + `version.json`. It keeps the last 10 build releases. Windows installs upgrade from that release.

Env vars: `PORT`, `DATA_DIR` (default `./data`), `BACKUP_DIR` (default `backups/` next to the data dir), `BACKUP_KEEP_DAYS` (30), `OPEN_BROWSER` (open the browser on start; set by the Windows launcher). A backup folder/retention saved in Settings (`DATA_DIR/settings.json`) overrides the env vars (`backupConfig()` in `paths.js`). `node server.js` works directly, but Settings → Restart needs the launcher (`LOOM_SUPERVISED=1`).

There is no build step, linter, or test suite. Dependencies: `express`, plus `html2canvas` (pinned 1.4.1), which the server serves from `node_modules` at `/vendor/html2canvas/` so dashboard image export works offline. Verify changes by running the app and using the UI, or the API with a token: `POST /api/auth/login` → `Authorization: Bearer <token>` plus `X-Factory: <factoryId>` on data routes. First login on a fresh data dir is admin/admin. Requires Node >= 18.

## Architecture

### Server modules

- `launcher.js` — forks `server.js`; re-forks when it exits with code 75 (Settings → Restart).
- `server.js` — Express app, factory data API (`/api/data`, `/api/warps`, `/api/looms`, `/api/deliveries`, `/api/clients`, `/api/stock`, `/api/order`) and domain rules. Every data route sits behind `requireAuth` + `factoryScope`, and handlers use `readDb(req.factoryId)` / `writeDb(req.factoryId, db)`.
- `auth.js` — `/api/auth` (login, me, password) and middleware: `requireAuth`, `requireAdmin`, `factoryScope` (X-Factory header + access check).
- `admin.js` — `/api/admin` router (admin only): factories CRUD, users CRUD, backups (list/download/delete/restore, backup-now, export), backup location, restart.
- `store.js` — `accounts.json` (users + factories), per-factory data files, password hashing, first-start migration.
- `backup.js` — whole-system backup files and log archives. `paths.js` — locations, `settings.json`, `writeJsonAtomic()`.
- `upgrade.js` — version, app status and self-upgrade from GitHub (Settings → App status / Upgrade; `/api/admin/upgrade/check`, `/upgrade`, `/upgrade/token`). The repo and branch come from package.json `repository` / `config.upgradeBranch`. A **git** install (has `.git`) refuses if tracked files have local changes, then fetches, fast-forwards, runs `npm install --omit=dev` if the package files changed, and rolls back with `git reset --hard` if the install or `node --check` fails. A **package** install (Windows, no git or npm) reads `VERSION.json` and checks the latest GitHub Release through its `version.json` asset. To upgrade it downloads `MyThari-windows.zip` (its own zip reader) and uses `MyThari/app/` from it. If there is no release, it falls back to the commit tarball (its own tar reader), refusing if bundled `node_modules` can't satisfy the new dependencies. It copies the files it replaces to `<backup folder>/app-before-upgrade-<stamp>/`, then swaps in the top-level `.js` files, `package*.json`, `public/`, `scripts/` and, from a release, `node_modules/`. `node/` (the running node.exe) and the `.bat` launchers are never replaced. Both take a `db-before-upgrade-…` backup first and restart with exit 75. The repo is private, so package installs need a GitHub token (`settings.githubToken`, read-only Contents). It is sent only to api.github.com, and git uses it as an `http.extraHeader`.

### Data layout (`DATA_DIR`)

- `accounts.json` — `users` `{ id, username, name, role: admin|user, factoryIds, salt, hash, tokenVersion, defaultPassword? }` and `factories` `{ id, name, location, ownerName, ownerPhone, ownerEmail }`. Admins can open every factory (their `factoryIds` stay empty); users only their `factoryIds`.
- `factories/<FAC-id>.json` — one factory's `{ warps, looms, deliveries, clients, stockMoves, activity }`. `activity` is the Log page: every data-changing route calls `logEvent(db, req, type, text)` (types `warp|loom|delivery|process|stock|party`, newest first, with `by`). When adding a route that changes data, log it too. Files without `activity` get one built from existing records by `seedActivity()` in `migrateDb()`. `activityVersion` < 2 renames old entries to the dispatch/delivery wording. `store.factoryFile()` only accepts generated `FAC-` ids, so ids can't escape the folder.
- `settings.json` — backup folder/retention and `sessionSecret`.
- First start on an old single-factory install (`initAccounts()`): `db.json` becomes factory "My factory", and the old `settings.admin` login (or admin/admin, flagged `defaultPassword`) becomes the admin user.

All writes are atomic (temp file + rename). Each request reads the factory file, mutates in memory and rewrites it. There is no locking. New records are `unshift`ed, so lists are newest-first. `migrateDb()` (in `readDb`) adds missing collections and backfills `warpId` on old deliveries.

### Auth and permissions

Tokens are stateless `<userId>.<tokenVersion>.<expiry>.<hmac>` (7 days, HMAC with `settings.sessionSecret`), so they survive restarts. Bumping a user's `tokenVersion` signs them out: own password change, or an admin editing another user. The user record is re-read on every request, so role and factory changes apply immediately. Role `user` can do everything in their factories **except** discard warps (`POST /api/warps/:id/discard`) and remove looms (`DELETE /api/looms/:id`), both `requireAdmin`. Settings rules: you can't delete or demote yourself, and at least one admin must remain. Deleting a factory, or resetting it (`POST /api/admin/factories/:id/reset`, which wipes its data but keeps the factory and users), requires `confirmName` and takes a backup first (`before-delete-factory` / `before-reset-factory`).

### Backups (`backup.js`)

Backup files hold the whole system: `{ format: "loom-saree-backup", version: 2, factories, data: { <id>: factoryData } }`. User accounts are not included. `backupNow()` refreshes `db-YYYY-MM-DD.json` on start and hourly and prunes old dailies. `snapshot(label)` writes never-pruned `db-<label>-<day>-<time>.json` (manual, before-reset, before-restore, before-delete-factory). Restoring a v2 file replaces the factory list and data (factories created later disappear from the list) and keeps users, dropping their assignments to missing factories. A v1 file (the old single-factory `{ warps, looms, … }`) gets `needsFactory` and is restored into a chosen factory. Backup names are checked against `BACKUP_NAME` to block path traversal.

Log archives (also `backup.js`): the Log page keeps `LOG_KEEP_DAYS` (30) days. `archiveLogs()` moves older `activity` entries of every factory into `<backup folder>/logs/logs-<day>-<time>.csv` (UTF-8 BOM, opens in Excel; names checked against `LOG_NAME`), then removes them from the factory files. It runs on start and hourly (`safeArchiveLogs()`), and from Settings → Logs (`POST /api/admin/logs/archive`). `GET /api/admin/logs-export` downloads every current log as CSV. Changing the backup folder with "copy existing" also copies `logs/`.

### Frontend (`public/index.html`)

A single page with inline CSS and vanilla JS, no framework. Session state lives in `session` (`token`, `user`, `factories`) and `currentFactoryId`; the token and last factory are kept in `localStorage`. `api()` adds `Authorization` and `X-Factory` headers and shows the sign-in screen on 401. `boot()` → `reloadSession()` (`/api/auth/me`) → `applySession()` (picks the factory, fills the header) → `route()` → `refresh()`. The header has the factory `<select>` (top-left) and the user menu (top-right: Settings for admins, Change password, Sign out). Use `isAdmin()` to hide admin-only controls (✕ discard, 🗑 remove loom, footer full-backup link, Settings).

Hash-routed views (`#home`, `#warps`, `#looms` (labelled **Production**), `#process`, `#stock`, `#log`, `#settings`) are `id="view-<name>"` elements toggled in `route()`; add new views to `views`. Without a factory, only Settings is reachable and `#noFactory` explains why.

- `#home` — dashboard (`renderHome()`): loom and active-warp tables split by width, with colour swatches, plus a Stock panel (every bucket per warp, from `stockOf()`). **Download** / **Share on WhatsApp** build a separate phone-width report (`reportHtml()`, `.mreport`/`.mr-*` CSS: stacked rows, no wide tables), render it off-screen at 480 CSS px with html2canvas and save a 1080 px wide JPG (`dashboardBlob()`). Keep it in step with `#homeReport` when the dashboard changes. WhatsApp uses the Web Share API (HTTPS only) or falls back to `wa.me` + `dashboardText()` and a JPG download.
- `#warps` — kanban (Ordered / Ready / Running; completed warps hidden). Pointer-event drag-and-drop works with mouse and touch (touch only from `.grip`). `moveBlock()` mirrors the server move rules.
- `#looms` (tab **Production**) — loom cards in Single / Triple width sections (a section is hidden when the factory has no looms of that width). Wording: taking sarees off a loom is a **Dispatch** (stored as a `deliveries` record via `/api/deliveries`, `deliveryDialog`; log type `dispatch`), recorded only here. Sending stock to a party is a **Delivery** (bucket `dispatched`, log type `delivery`). Internal names keep the old meaning; only labels changed.
- `#process` — per-warp cards (`renderProcess()`): Dispatched (bucket `sent`) → Delivered/godown → **Send to process** (checking: `sortDialog` from `delivered` into process / mai / damage) → Process → Folding → **Add to stock** (`sortDialog` from `folding`). `SORT_MODE` configures both splits, and other steps use `ask()` / `STOCK_STEP`.
- `#stock` — `renderStock()`: pooled totals only (no warp details) for Stock, Greese (mai, + at cleaning), Lot, Damage and With parties, each with its actions in one shared form `actDialog` configured by `ACTS` (party when needed, then qty), plus the Parties list. The UI says "party" everywhere, but the data keeps `clients` / `clientId` / `/api/clients`.
- `#log` — `renderLog()`: `db.activity` with a type filter and search, shown 200 at a time.

Tile order: dragging a warp within its column, or a loom within its width section, live-moves the DOM node (`placeAmong()`) and saves the column's ids with `POST /api/order` (sets `order` = index). `byOrder()` sorts by `order`; items without one (new) come first. Dragging a warp to another column still changes its stage (`moveWarp()`).
- `#settings` — `loadSettings()`: factories, users, backups, backup location, restart.

All forms are `<dialog>`s. `ask()` is a generic prompt (select, text/number input, or confirm; resolves `null` on cancel). `toast()` shows confirmations, and `flashIds` highlights cards that just changed. Render every user string through `esc()`. Note: after an `await` in a click handler, `e.currentTarget` is null, so capture it first.

Styling: the first `<style>` block is the original base; the second holds the gradient theme (`:root` tokens, `--grad`) and component styles. The header must not use `overflow:hidden`, or the user menu dropdown gets clipped.

### Domain rules (enforced server-side, mirrored client-side)

- `widthType` is `"single"` or `"triple"`; warps only go on looms of the same width. Looms need only `name` + `widthType`.
- Warp lifecycle (stored `status`): `Ordered` → `Ready` (`readyDate`) → `In Use` (`startedAt`) → `Completed`; also `Discarded`. Board moves use `POST /api/warps/:id/move` (`to: ordered|ready|running`, + `loomId`). Allowed moves: ordered↔ready (back to ordered only if never woven), ready/ordered→running, running→ready (frees the loom). `assignError()`/`assignWarp()` are shared by every assignment path except loom creation.
- Delivery: saree length `SAREE_M` = 6.3 m. Meters used = `sarees * 6.3`, divided by 3 on triple width (quantities must be multiples of 3). Optional `lrNumber`.
- A warp with less than 6.3 m left is spent: `settleSpentWarps()` marks it `Completed`, sets the loom to `Warp Completed` and clears the link. The offcut stays in `remainingMeters`. It runs after deliveries and in `readDb()`. New warps must be ≥ 6.3 m. Client mirror: `warpSpent()`.
- Discard is refused while the warp is on a loom. Removing a loom requires it to be stopped (`stoppedAt`, set by `POST /api/looms/:id/stop`, cleared by `/resume`); a warp still on it returns to Ready. Stopped looms reject deliveries and assignment.
- Stock is derived, never stored: `stockFor(db, warpId?)` / `stockOf(warpId?)` run a ledger over `STOCK_BUCKETS`. With a warp id it covers one warp, without one every warp (the pool). Deliveries fill `sent`. Each `stockMoves` entry takes `qty` from `from` and adds it to `to`, and an adjustment (`type: "adjust"`, no `from`, signed `qty`) changes one bucket. Per-warp moves (`PROCESS_MOVES`, need `warpId`): sent→delivered→process→folding. `POST /api/stock/sort` (`from` + counts, see `SORTS`) splits one warp's sarees: `delivered` into process|mai|damage (checking before process) or `folding` into stock|mai|lot|damage (Add to stock). Both stay tagged with the warp. After that, sarees are pooled: `POOL_MOVES` carry no warp and are checked against pool totals: mai→cleaning→stock (each send is a cleaning batch; a return must name its `batchId` and stay within that batch's pending count, see `cleaningBatches()` on both sides; the Stock page shows a Cleaning register), stock→damage (damage return), stock→dispatched (needs `clientId`), dispatched→stock (party return, limited by `partyHolds()`), damage→returned (to the loom owner = factory owner, stored as `ownerName`). Lot has no outgoing move. `POST /api/stock/adjust` sets the pooled stock/mai/lot/damage count (`ADJUSTABLE`). Moves carry `by` and an optional `note`.
- Stock migrations in `migrateDb()`: `stockVersion` < 2 gets a `folding` twin for each legacy `stock` move (Folding stage added); < 3 fills `from` on legacy moves and adds one `sent→delivered` move per warp for all earlier deliveries (Sent stage added), so old counts are unchanged.
- Add warp takes the length in meters or sarees (`warpLength()`: sarees × 6.3, ÷ 3 on triple width, multiples of 3 there); only meters are sent to the server. The colour name and picker sync both ways: a known name sets the picker, and picking fills `nearestColourName()` unless the user typed their own name (`dataset.auto`).
- Warp display state comes from `warpState()`, not the stored string. Bars turn red below `LOW_SHARE` (20%). Colours come from `bodyHex`/`borderHex`, or `colourOf()` name mapping.
- The 6.3 m / triple-width maths and the spent rule exist on both sides (`SAREE_M`, `warpSpent()`, `updatePreview()`); change them together.

### Windows package

`scripts/build-windows.js` downloads a pinned, checksum-verified Node win-x64 runtime into `.cache/` and copies the app modules (keep its file list in sync when adding server files; it includes `upgrade.js`) and writes `VERSION.json` (git commit + `BUILD_NUMBER`, used by Upgrade; also copied to `dist/version.json` for the release), plus `public/`, `scripts/reset-data.js` and `node_modules` into `dist/MyThari/app/`. The desktop shortcut uses `app/public/img/thari.ico`. It also writes CRLF `.bat` launchers that `call settings.bat`. Data and backups sit next to the launchers, so updating means replacing `app/`.
