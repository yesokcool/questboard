# Questboard: notes for Claude

A shared co-op game backlog (a kanban of Steam games) on one Cloudflare Worker.
`README.md` covers what it does and how to run it.

**If `private/README.md` exists, read it first.** It holds the maintainer's notes
about their own board. `private/` is gitignored and never published.

## Files
- `worker.js`: the whole server. Routes, validation, the Steam/ProtonDB refresh, crons, and the `Votes` Durable Object.
- `index.html`: the whole client (vanilla JS + CSS, inline, no build step). The Worker imports it as text and fills in `{{TITLE}}`, `{{DESCRIPTION}}` and `{{ORIGIN}}` per request (`page()` in `worker.js`).
- `wrangler.example.toml`: the template; each board's `wrangler.toml` is gitignored.
- `seed-board.example.json`: the demo board.

## Data
- KV `GAMES_KV`:
  - `board` (lanes, cards, `version`, `dismissed`) and `steam` (price/cover/compat cache);
  - `history:*` (every previous save, 30-day TTL) and `backup:*` (weekly, permanent);
  - `thumbs` + `thumb:<appid>` (optional small covers) and `img:*` (optional icons and link-preview image).
- Durable Object `Votes` (one instance, `idFromName("board")`): `votes`, `round`, `rounds` (last 20, for manual undo) and `activity` (last 400).
- Saves send the board's current `version`. A stale one gets **409**: reload and retry, never force.
- `cleanLanes()` keeps only known fields with bounded sizes. A new card or column field must be added there, or saves drop it.

## Behavior worth knowing
- **Trashed column:** there is always exactly one Trashed column (`id: trash`, `trash: true`), and it's always last. Deleting moves cards there with `fromLane`/`fromLaneName` so they can be restored. "Delete forever" and "Empty" exist only inside it.
- **Activity:** the server diffs each save (`describeChanges`). Each entry has the editor's chosen name (`X-Editor`) and a 4-hex tag, an HMAC of the IP with `ACTIVITY_SALT`. There's no tag without the salt. One person's votes in a row merge into one line; taking a vote back within 15 minutes removes it from that line.
- **Prices:** columns with `showPrices` show them. `sortByDiscount` (an old name, kept for compatibility) sorts by **lowest current price**, with bigger discounts breaking ties and unpriced games last.
- **Compat chip (warning only):** a game is fine if it's native Linux, OR Deck verified/playable, OR ProtonDB gold/platinum while Valve's SteamOS rating isn't "unsupported". Doubtful games get an amber "⚠️ Linux" chip. Trust ProtonDB over Valve. The only red label is ProtonDB "Borked". The daily cron refreshes ProtonDB for 30 apps per run, oldest first, to stay under the Workers subrequest cap.
- **Votes** are keyed by the lowercased saved name and need the edit password.

## Inside Yap
Yap serves this page on its own origin at `/board` and proxies the paths in its `BOARD_PATHS`. Two contracts with Yap:
- **Keep `data-lane` on columns and `data-id` on cards.** Yap anchors everyone's pointers to them.
- **localStorage keys `gk-name`, `gk-theme` (`dark`/`light`), `gk-density`, `gk-password`.** Yap pre-fills `gk-name` and `gk-theme`. Don't rename them.

Yap locks the page down with a hash-based CSP. Inline scripts are fine; `javascript:` links, inline event-handler attributes and third-party scripts are not.

A new path the page calls must be added to Yap's `BOARD_PATHS` too, and to the README.

## Testing locally
```sh
npx wrangler kv key put board --path seed-board.example.json --binding GAMES_KV --local --persist-to <dir> -c wrangler.example.toml
npx wrangler dev -c wrangler.example.toml --persist-to <dir> --test-scheduled --var EDIT_PASSWORD:test --port 8790
curl "http://localhost:8790/__scheduled?cron=0+11+*+*+*"     # run the daily Steam refresh
```
