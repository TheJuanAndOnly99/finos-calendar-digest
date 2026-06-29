# finos-calendar-digest

Generates a rolling "This Week At FINOS" digest for GitHub Pages.

Live output: <https://thejuanandonly99.github.io/finos-calendar-digest/>

By default the output shows the **previous**, **current**, and **next** NYC
week (Monday–Sunday), with start times in both **New York** and **London**
time and a one-click **Sign Up** link to the LFX Zoom registration page.
Pass `--month` / `MONTH` to render a full calendar month instead.

> This project calls the LFX Project Control Center public JSON endpoint
> (`pcc-bff.platform.linuxfoundation.org/.../public/meetings/<slug>`) — the
> same backend that powers the public Zoom-LFX calendar at
> `zoom-lfx.platform.linuxfoundation.org/meetings/finos` — and reads the
> response directly with `fetch`.

## How it works

`scripts/finos-weekly-calendar.mjs` does the following:

1. Fetches the current schedule from the LFX public meetings API:
   `https://pcc-bff.platform.linuxfoundation.org/production/api/v2/itx-services/public/meetings/<slug>?view=pcc`
2. For the default rolling view it also pulls the `/past` endpoint for the
   previous and current NYC weeks, so meetings that already happened are not
   silently dropped when LFX hides completed events.
3. Merges a small persistent cache (`.cache/current-week-meetings.json`) as a
   second-level fallback, then re-saves the cache for the active week.
4. Buckets meetings into NYC weeks (always Monday–Sunday, including spillover
   days at month boundaries), formats each line as
   `hh:mm a NYC / hh:mm a UK - <title> - [Sign Up](<url>)`, and emits the
   digest as Markdown (default) or plain text.
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

By default it prints the rolling three-week digest (previous, current, and
next NYC week) to stdout.

### Common options

All configuration is done via env vars or the single `--month` flag.

| Variable             | Default                                  | Description |
| -------------------- | ---------------------------------------- | ----------- |
| `MONTH` / `--month`  | _(unset — rolling 3-week view)_          | Month to render instead. Also accepts `YYYYMM`. |
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

`workflow_dispatch` accepts:

- `range`: `rolling-weeks` (default, same as the daily schedule) or `custom-month`
- `month`: required when `range` is `custom-month` (`YYYY-MM`)
- `format`: `markdown` | `plain`

Weeks always render Monday–Sunday in NYC. Boundary weeks include spillover
days (and meetings) from the previous or next month.

## Repository layout

```
scripts/finos-weekly-calendar.mjs   # the digest generator
.github/workflows/                  # daily run + Pages deploy
output/                             # generated md / html (gitignored)
.cache/                             # persistent current-week cache (gitignored)
```

## Output format

```
## FINOS calendar — June 22–July 12, 2026

Rolling view: previous, current, and next NYC week (Monday–Sunday). Source: ...

### June 22–28, 2026

Monday, June 22
...
```

Times are computed from each event's ISO start, then converted to
`America/New_York` and `Europe/London`. Weeks are grouped using ISO weeks
anchored to NYC Monday 00:00.
