# finos-calendar-digest

Generates a monthly "This Week At FINOS" digest.

Live output: <https://thejuanandonly99.github.io/finos-calendar-digest/>

The output groups every meeting in a calendar month by ISO week and weekday,
with start times in both **New York** and **London** time and a one-click
**Sign Up** link to the LFX Zoom registration page.

> This project calls the LFX Project Control Center public JSON endpoint
> (`pcc-bff.platform.linuxfoundation.org/.../public/meetings/<slug>`) — the
> same backend that powers the public Zoom-LFX calendar at
> `zoom-lfx.platform.linuxfoundation.org/meetings/finos` — and reads the
> response directly with `fetch`.

## How it works

`scripts/finos-weekly-calendar.mjs` does the following:

1. Fetches the current schedule from the LFX public meetings API:
   `https://pcc-bff.platform.linuxfoundation.org/production/api/v2/itx-services/public/meetings/<slug>?view=pcc`
2. For the current month it also pulls the `/past` endpoint for the current
   NYC ISO week, so meetings that already happened earlier this week are not
   silently dropped when LFX hides completed events.
3. Merges a small persistent cache (`.cache/current-week-meetings.json`) as a
   second-level fallback, then re-saves the cache for the active week.
4. Buckets meetings into NYC weeks, formats each line as
   `hh:mm a NYC / hh:mm a UK - <title> - [Sign Up](<url>)`, and emits the
   month digest as Markdown (default) or plain text.
5. Optionally writes a styled HTML version (via a small inline Markdown ->
   HTML converter) for publishing.

## Requirements

- Node.js 20+
- `npm install` (only runtime dep is [`luxon`](https://moment.github.io/luxon/))

## Local usage

Install dependencies and run the script:

```bash
npm install
node scripts/finos-weekly-calendar.mjs
```

By default it prints the digest for the current month (in `America/New_York`)
to stdout.

### Common options

All configuration is done via env vars or the single `--month` flag.

| Variable             | Default                                  | Description |
| -------------------- | ---------------------------------------- | ----------- |
| `MONTH` / `--month`  | current NYC month (`YYYY-MM`)            | Month to render. Also accepts `YYYYMM`. |
| `PROJECT_SLUG`       | `finos`                                  | LFX project slug to query. |
| `PUBLIC_MEETINGS_API`| LFX production endpoint                  | Override the base meetings URL. |
| `FORMAT`             | `markdown`                               | Set to `plain` to disable Markdown link syntax. |
| `OUTPUT`             | _(unset)_                                | If set, write Markdown to this path. |
| `OUTPUT_HTML`        | _(unset)_                                | If set, write HTML to this path. |
| `WEEK_CACHE_PATH`    | _(unset)_                                | Path to the persistent current-week cache JSON. |
| `FETCH_TIMEOUT_MS`   | `120000`                                 | Per-request timeout. |
| `FETCH_MAX_ATTEMPTS` | `5`                                      | Retries with exponential backoff on transient errors. |

### Examples

Render a specific month and write both Markdown and HTML:

```bash
MONTH=2026-05 \
OUTPUT=output/finos-this-month.md \
OUTPUT_HTML=output/finos-this-month.html \
node scripts/finos-weekly-calendar.mjs
```

Render a different LFX project as plain text:

```bash
PROJECT_SLUG=lf-decentralized-trust FORMAT=plain \
node scripts/finos-weekly-calendar.mjs
```

## GitHub Actions

`.github/workflows/finos-this-week-at.yml` runs the script daily at 12:00 UTC
and on manual dispatch, and:

- Restores / saves the current-week cache via `actions/cache`.
- Writes `output/finos-this-month.md` and `output/finos-this-month.html`.
- Uploads them as a build artifact (90-day retention).
- Publishes the HTML to GitHub Pages (`output/index.html`) at
  <https://thejuanandonly99.github.io/calendar-scrape/>.

`workflow_dispatch` accepts an optional `month` (`YYYY-MM`) and a `format`
(`markdown` | `plain`).

## Repository layout

```
scripts/finos-weekly-calendar.mjs   # the digest generator
.github/workflows/                  # daily run + Pages deploy
output/                             # generated md / html (gitignored)
.cache/                             # persistent current-week cache (gitignored)
```

## Output format

```
## FINOS calendar — May 2026

Source: [FINOS meetings (month)](https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month).

This Week At FINOS

Monday, May 4
10:00 AM NYC / 03:00 PM UK - <Meeting title> - [Sign Up](https://zoom-lfx.platform.linuxfoundation.org/meeting/<id>?invite=true)
...
```

Times are computed from each event's ISO start, then converted to
`America/New_York` and `Europe/London`. Weeks are grouped using ISO weeks
anchored to NYC Monday 00:00.
