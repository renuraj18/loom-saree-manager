# My Thari – Track all my loom production

A mobile-friendly Node.js + Express web app to manage warp records, loom records, and delivery/output entries.

## Included features
- Drag warp tiles within a column, and loom tiles within their width section, to rearrange them (saved per factory).
- Stock flow: delivered → process → folding → in stock → dispatched.
- Warp length can be entered in meters or sarees (1 saree = 6.3 m; on triple width, 3 sarees per 6.3 m).
- Warp colours: pick a shade (the nearest colour name is filled in) or type a name (the shade is set).
- Add warps with ID/name, single/triple width, meters, body colour, and border colour.
- Add looms with loom number, width type, plan/design, colours, optional planned meters, and optional warp allocation.
- Warp and loom width types must match.
- Prevents assigning the same active warp to multiple looms.
- Mark delivery/output by entering the total number of sarees for a loom.
- Standard saree length is 6.3 meters.
- Single-width: 1 saree = 6.3 meters of warp length.
- Triple-width: 3 sarees across the three widths = 6.3 meters of shared warp length. Enter a multiple of 3.
- Automatically updates remaining warp meters and stores delivery history.
- JSON file persistence for a simple starter app.

## Requirements
- Node.js 18 or newer
- npm

## Run locally
```bash
npm install
npm start
```
Open http://localhost:3000

To open from another device on the same Wi-Fi, find your computer's LAN IP and open `http://YOUR-LAN-IP:3000`. Ensure your firewall permits inbound connections.

## Branding
The master logo is `public/Thari Logo.png` (transparent). `python3 scripts/build-logo.py "public/Thari Logo.png" public/img` (needs Pillow) regenerates the web copies in `public/img/`: `thari-logo-640.png` / `-1280.png` (header, sign-in, dashboard image), `thari-icon-64.png` (favicon), `thari-icon-180.png` / `-512.png` (phone home screen, web manifest) and `thari.ico` (Windows shortcut).

## Sign in, factories and users
- Everyone signs in. On a new install the first login is **admin / admin**; change it from the user menu (top right) → **Change password**.
- The **factory picker** at the top left switches factories. Each factory has its own warps, looms, deliveries, stock and parties.
- Admins open **Settings** from the user menu to add/edit/delete factories (name, location, owner name/phone/email), add users, set their role and which factories they can open, manage backups and the backup folder, and restart the app.
- **Users** only see their assigned factories and cannot discard warps or remove looms.
- Upgrading from the single-factory version: on first start the old data becomes a factory called "My factory" and the old admin login becomes the admin user.

## Backups
- While the app runs it saves a daily copy of all factories to `backups/db-YYYY-MM-DD.json` (refreshed every hour; the last 30 days are kept). User accounts are not part of backups.
- Use another disk or a cloud-synced folder: set it in Settings, or start with `BACKUP_DIR=/path/to/folder npm start`. `BACKUP_KEEP_DAYS` changes how many days are kept; `DATA_DIR` moves the data folder.
- Admins: **Download backup** at the bottom of the app downloads a full backup (all factories).
- To restore: Settings → Backups → Restore. Everything is backed up first, so a restore can be undone.

## Reset data
```bash
npm run reset-data
```
Type `RESET` to confirm. Every factory's data is cleared (factories and users stay); a full backup is saved first as `backups/db-before-reset-<date>-<time>.json`.

## Windows package (one-click, no install)
```bash
npm install
npm run build:win
```
Creates `dist/MyThari-windows.zip` (bundles the official Windows Node.js runtime). On the Windows PC: unzip, double-click **Start My Thari** (or run **Create desktop shortcut** once). The zip's `README.txt` covers backups, restore, reset and settings.

Every push to `main` also builds this zip on GitHub Actions (`.github/workflows/windows-release.yml`) and publishes it as the latest GitHub Release (`v1.0.0-build.N`). Installed apps upgrade from it in **Settings → Upgrade**: a full backup is taken first, then the new build is installed and the app restarts. The repository is private, so each Windows install needs a GitHub token with read-only Contents access, saved once in Settings → Upgrade.

## Deploy to Render
1. Push this folder to a GitHub repository.
2. Create a Render **Web Service** connected to that repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Select a free instance if available for your account/region.

The server listens on `0.0.0.0` and uses `process.env.PORT`.

## Important production note
This app persists data to `data/` (`accounts.json` plus one file per factory in `data/factories/`, with daily copies in `backups/`). On many cloud free services, local disk contents may not be durable across redeploys/restarts. Before relying on this for real business records, use a persistent database such as PostgreSQL and configure backups. The app has sign-in and roles, but serves plain HTTP on your network; use HTTPS (e.g. Render) before exposing it to the internet.
