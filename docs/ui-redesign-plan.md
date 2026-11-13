# My Thari UI redesign: plan and status

Last updated: 13 November 2026.

## Status

| Phase | What | Branch | PR | State |
|---|---|---|---|---|
| 1 | Foundation: shared tokens, components, SVG icons | `feature/ui-foundation` | [#3](https://github.com/renuraj18/loom-saree-manager/pull/3) → `feature/party-factory-app` | Open, waiting for testing |
| 2 | App frame: grouped menu, phone bottom bar, alert strip | `feature/ui-nav` | [#4](https://github.com/renuraj18/loom-saree-manager/pull/4) → `feature/ui-foundation` (builds on #3) | Open, waiting for testing |
| 3 | Page by page | not started | | |
| 4 | Forms and dialogs | not started | | |
| 5 | Party app rebuild | not started | | |
| 6 | Polish | not started | | |

Merge order: #3 first, then #4 (check that #4's base has switched to `feature/party-factory-app` before merging it).
`release/wages` is 10 commits behind and conflicts with one commit only on it (`cba892d`); merge `feature/party-factory-app` into it when releasing.

## Decisions so far

- Keep a **top menu** on desktop (a left sidebar was tried and moved back on purpose). It is grouped: Home · Floor ▾ · Party orders · Stock ▾ · Money ▾ · Designs · Log.
- **Weft** sits in the Floor group with Looms, Production, Warps and Bobbins.
- Phones get a **bottom bar**: Home · Looms · Dispatch · Stock · More (More opens every page as a sheet).
- Keep the word **"Parties"** for stock buyers (no rename).
- No framework and no build step: plain HTML, CSS and JS, because the Windows package and self-upgrade copy `public/` as it is.
- Styles live in `public/css/` (`tokens.css` → `components.css` → `app.css` / `party.css`). Use tokens, not raw colours. Only two breakpoints: 600 px (phones) and 1000 px (desktop).
- Icons: `public/img/icons.svg` sprite, `<svg class="ic"><use href="img/icons.svg#name"></use></svg>`.

## Testing checklist for #3 and #4

Test on the PC browser and on a phone, with a copy of real data if possible.

**Phase 1 (#3)**
- [ ] Every page looks the same as before, except: white secondary buttons (Cancel, Download report), white panels with a light border, outlined secondary buttons on Process and Stock cards.
- [ ] "Download report" and "Share on WhatsApp" still make the report image.
- [ ] Wage sheet still prints (Print / Save as PDF).
- [ ] Party app (party login) looks right on desktop and phone.
- [ ] A tablet-size window (600–1000 px) looks acceptable; this width changed on purpose and was not checked.

**Phase 2 (#4)**
- [ ] Desktop: Floor, Stock and Money open their lists; picking a page works; the group shows the page name.
- [ ] Phone: bottom bar works; Dispatch opens Production; More lists every page and closes after picking one.
- [ ] Warnings show as one line each; Show all / Show less works; Home doesn't repeat the low-warp and party notices.
- [ ] A **Stock only** factory: Money and Designs are hidden, Floor still works.
- [ ] A factory **with no parties**: Party orders is hidden.
- [ ] A user (not admin) sees the right pages.

## Next phases

**Phase 3: page by page**
- Looms: one page for status and dispatch (merge Looms and Production, with a cards/table switch). Fix the swapped route names (`#looms` is Production) with redirects for old bookmarks.
- Warp and bobbin boards on phones: one column at a time with tabs (Ordered / Ready / Running) instead of three stacked columns.
- Stock and Process: show the flow as steps (Godown → Process → Folding → Stock).
- Wages: cleaner pay table and a Settle button that stays in view.
- Settings: split into tabs (Factories, Users, Backups, Licence, App).
- Home: already redesigned; only align it with the tokens.

**Phase 4: forms and dialogs**
- All 29 dialogs use the same header and footer; on phones they open as bottom sheets.
- Number fields get `inputmode="numeric"`; every tap target is at least 44 px.
- Keep `ask()` and `toast()`, restyled.

**Phase 5: party app**
- Rebuild `party.html` on the shared tokens, components and app frame so both apps look like one product.

**Phase 6: polish**
- Accessibility (contrast, focus rings), speed on a cheap Android phone.
- Optional: dark mode, Tamil or other languages, splitting the page JS into ES module files.

## How the UI was checked (for the next phases)

- Run the app on a throwaway data folder: `PORT=3123 DATA_DIR=<tmp>/data BACKUP_DIR=<tmp>/backups node server.js`, then add demo looms, warps and dispatches through the API (first login admin/admin).
- Before and after each change, record the computed style of every element on every page at 390 px and 1366 px, and compare, so only intended changes get through.
- `npm test` must pass (the static tests check stylesheet links, CSS variables, breakpoints, icon ids, menu and bottom-bar links).
