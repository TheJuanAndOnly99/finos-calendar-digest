#!/usr/bin/env node
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exit } from "node:process";
import { DateTime } from "luxon";

const NYC = "America/New_York";
const UK = "Europe/London";
const DEFAULT_API =
  "https://pcc-bff.platform.linuxfoundation.org/production/api/v2/itx-services/public/meetings";

function isMeetingLine(line) {
  // Detailed (pre/post link convert): "09:00 AM NYC / …"
  // Compact markdown: "[Title](url)" → after convert may include target/rel attrs
  // Compact plain: "Title (url)"
  return (
    /^\d{1,2}:\d{2} [AP]M NYC /.test(line) ||
    /^\[[^\]]+\]\(https?:\/\/[^\s)]+\)$/.test(line) ||
    /^<a href="https?:\/\/[^"]+"[^>]*>[^<]+<\/a>$/.test(line) ||
    /^.+ \(https?:\/\/[^\s)]+\)$/.test(line)
  );
}

function isDayHeading(line) {
  if (/^[A-Za-z]+, [A-Za-z]+ \d+$/.test(line)) return true;
  // Day-link view: the day itself is the calendar link.
  if (
    /^\[[A-Za-z]+, [A-Za-z]+ \d+\]\(https:\/\/calendar\.finos\.org\/\?view=day&date=\d{4}-\d{2}-\d{2}\)$/.test(
      line
    )
  ) {
    return true;
  }
  if (
    /^[A-Za-z]+, [A-Za-z]+ \d+ \(https:\/\/calendar\.finos\.org\/\?view=day&date=\d{4}-\d{2}-\d{2}\)$/.test(
      line
    )
  ) {
    return true;
  }
  return false;
}

function dayHeadingHtml(raw, escapeHtml) {
  const linked = raw.match(
    /^\[([^\]]+)\]\((https:\/\/calendar\.finos\.org\/\?view=day&date=\d{4}-\d{2}-\d{2})\)$/
  );
  const plain = raw.match(
    /^([A-Za-z]+, [A-Za-z]+ \d+) \((https:\/\/calendar\.finos\.org\/\?view=day&date=\d{4}-\d{2}-\d{2})\)$/
  );
  const match = linked || plain;
  if (!match) return `<h4>${escapeHtml(raw)}</h4>`;
  return `<h4><a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a></h4>`;
}

/** Plain meeting title in the day-link view (no per-meeting URL). */
function isPlainTitleLine(line) {
  if (!line.trim()) return false;
  if (line.startsWith("## ")) return false;
  if (isWeekHeading(line) || isDayHeading(line)) return false;
  if (line === "No meetings scheduled.") return false;
  return true;
}

function isWeekHeading(line) {
  return line.startsWith("### ") || line.startsWith("This Week At FINOS");
}

function closeList(out, inList) {
  if (inList.value) {
    out.push("</ul>");
    inList.value = false;
  }
}

function closeWeek(out, inWeek) {
  if (inWeek.value) {
    out.push("</section>");
    inWeek.value = false;
  }
}

/** Convert digest markdown (header + weeks) into HTML body fragments. */
function markdownToBody(markdown) {
  const lines = markdown.split("\n");
  const header = [];
  const weeks = [];
  const inList = { value: false };
  const inWeek = { value: false };
  let inDay = false;
  let out = header;

  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const withLinks = (s) =>
    escapeHtml(s).replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trimEnd();
    if (!raw.trim()) {
      closeList(out, inList);
      continue;
    }

    if (raw.startsWith("## ")) {
      closeList(out, inList);
      closeWeek(out, inWeek);
      inDay = false;
      out = header;
      out.push(`<h2>${withLinks(raw.slice(3))}</h2>`);
      continue;
    }

    if (isWeekHeading(raw)) {
      closeList(out, inList);
      closeWeek(out, inWeek);
      inDay = false;
      out = weeks;
      out.push('<section class="week">');
      inWeek.value = true;
      const title = raw.startsWith("### ") ? raw.slice(4) : raw;
      out.push(`<h3>${withLinks(title)}</h3>`);
      continue;
    }

    if (isDayHeading(raw)) {
      closeList(out, inList);
      inDay = true;
      out.push(dayHeadingHtml(raw, escapeHtml));
      const next = lines.slice(i + 1).find((l) => l.trim());
      const nextLine = next ? next.trimEnd() : "";
      if (!nextLine || !(isMeetingLine(nextLine) || isPlainTitleLine(nextLine))) {
        out.push('<p class="empty-day">No meetings scheduled.</p>');
      }
      continue;
    }

    if (raw === "No meetings scheduled.") {
      closeList(out, inList);
      out.push('<p class="empty-day">No meetings scheduled.</p>');
      continue;
    }

    if (isMeetingLine(raw) || (inWeek.value && inDay && isPlainTitleLine(raw))) {
      if (!inList.value) {
        out.push("<ul>");
        inList.value = true;
      }
      out.push(`<li>${withLinks(raw)}</li>`);
      continue;
    }

    closeList(out, inList);
    // Intro / source lines stay in the shared header area.
    if (!inWeek.value) {
      out = header;
      out.push(`<p class="intro">${withLinks(raw)}</p>`);
    } else {
      out.push(`<p class="intro">${withLinks(raw)}</p>`);
    }
  }

  closeList(out, inList);
  closeWeek(out, inWeek);

  return { headerHtml: header.join("\n"), weeksHtml: weeks.join("\n") };
}

function wrapDigestHtml(headerHtml, detailedWeeksHtml, compactWeeksHtml, dayLinkWeeksHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FINOS Calendar Digest</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 980px; margin: 24px auto; line-height: 1.5; padding: 0 16px; color: #1a1a1a; background: #fff; color-scheme: light; }
    h2 { margin: 0 0 12px; font-size: 1.75rem; }
    .intro { margin: 0 0 24px; color: #444; }
    .view-toggle { display: flex; gap: 8px; margin: 0 0 8px; flex-wrap: wrap; }
    .view-toggle button {
      appearance: none; border: 1px solid #ccc; background: #f5f5f5; color: #222;
      padding: 8px 14px; font: inherit; font-size: 0.95rem; cursor: pointer; border-radius: 6px;
    }
    .view-toggle button[aria-selected="true"] {
      background: #0b5fff; border-color: #0b5fff; color: #fff;
    }
    .view-toggle button:focus-visible { outline: 2px solid #0b5fff; outline-offset: 2px; }
    .view-panel[hidden] { display: none; }
    .week { margin: 32px 0; padding: 20px 0 8px; border-top: 1px solid #ddd; }
    .view-panel > .week:first-child { border-top: none; padding-top: 0; margin-top: 16px; }
    h3 { margin: 0 0 16px; font-size: 1.25rem; }
    h4 { margin: 20px 0 8px; font-size: 1rem; color: #333; }
    ul { margin: 0 0 8px; padding-left: 1.25rem; }
    li { margin: 6px 0; }
    .empty-day { margin: 0 0 8px; color: #888; font-size: 0.95rem; font-style: italic; }
    a { color: #0b5fff; }
  </style>
</head>
<body>
${headerHtml}
<nav class="view-toggle" role="tablist" aria-label="Digest format">
  <button type="button" role="tab" id="tab-detailed" aria-controls="view-detailed" aria-selected="true" data-view="detailed">With times</button>
  <button type="button" role="tab" id="tab-compact" aria-controls="view-compact" aria-selected="false" data-view="compact">Titles only</button>
  <button type="button" role="tab" id="tab-daylink" aria-controls="view-daylink" aria-selected="false" data-view="daylink">Day links</button>
</nav>
<div id="view-detailed" class="view-panel" role="tabpanel" aria-labelledby="tab-detailed">
${detailedWeeksHtml}
</div>
<div id="view-compact" class="view-panel" role="tabpanel" aria-labelledby="tab-compact" hidden>
${compactWeeksHtml}
</div>
<div id="view-daylink" class="view-panel" role="tabpanel" aria-labelledby="tab-daylink" hidden>
${dayLinkWeeksHtml}
</div>
<script>
(function () {
  var tabs = document.querySelectorAll(".view-toggle [role=tab]");
  var panels = {
    detailed: document.getElementById("view-detailed"),
    compact: document.getElementById("view-compact"),
    daylink: document.getElementById("view-daylink")
  };
  function select(view) {
    tabs.forEach(function (tab) {
      var on = tab.getAttribute("data-view") === view;
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    Object.keys(panels).forEach(function (key) {
      if (key === view) panels[key].removeAttribute("hidden");
      else panels[key].setAttribute("hidden", "");
    });
    try { localStorage.setItem("finos-digest-view", view); } catch (e) {}
  }
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () { select(tab.getAttribute("data-view")); });
  });
  var saved = null;
  try { saved = localStorage.getItem("finos-digest-view"); } catch (e) {}
  if (saved === "detailed" || saved === "compact" || saved === "daylink") select(saved);
})();
</script>
</body>
</html>
`;
}

function markdownToHtml(detailedMarkdown, compactMarkdown, dayLinkMarkdown) {
  const detailed = markdownToBody(detailedMarkdown);
  const compact = markdownToBody(compactMarkdown);
  const dayLink = markdownToBody(dayLinkMarkdown);
  return wrapDigestHtml(
    detailed.headerHtml,
    detailed.weeksHtml,
    compact.weeksHtml,
    dayLink.weeksHtml
  );
}

/** When unset, the digest uses a rolling NYC Monday–Sunday window (see main). */
function parseExplicitMonthArg(argv) {
  const i = argv.indexOf("--month");
  if (i !== -1 && argv[i + 1]) return argv[i + 1].trim();
  const env = process.env.MONTH?.trim();
  if (env) return env;
  return null;
}

function padMonth(s) {
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4)}`;
  return s;
}

function monthBoundsNyc(monthStr) {
  const ym = padMonth(monthStr);
  const first = DateTime.fromISO(`${ym}-01`, { zone: NYC });
  if (!first.isValid) throw new Error(`Invalid month "${monthStr}". Use YYYY-MM.`);
  return { start: first.startOf("day"), end: first.plus({ months: 1 }).startOf("day") };
}

function mondayMidnightSameIsoWeek(dtNyc) {
  const wd = dtNyc.weekday;
  return dtNyc.minus({ days: wd - 1 }).startOf("day");
}

function formatNycDaySpan(startNyc, endNyc) {
  if (startNyc.year !== endNyc.year) {
    return `${startNyc.toFormat("MMMM d, yyyy")}–${endNyc.toFormat("MMMM d, yyyy")}`;
  }
  if (startNyc.month === endNyc.month) {
    return `${startNyc.toFormat("MMMM d")}–${endNyc.toFormat("d, yyyy")}`;
  }
  return `${startNyc.toFormat("MMMM d")}–${endNyc.toFormat("MMMM d, yyyy")}`;
}

function formatWeekRangeTitle(mondayNyc) {
  return formatNycDaySpan(mondayNyc, mondayNyc.plus({ days: 6 }));
}

function finosDayUrl(isoDate) {
  return `https://calendar.finos.org/?view=day&date=${isoDate}`;
}

function signupUrl(ext) {
  if (ext?.share_url) return withInviteParam(ext.share_url);
  const id = ext?.meeting_id;
  if (id) return withInviteParam(`https://zoom-lfx.platform.linuxfoundation.org/meeting/${id}`);
  return withInviteParam("https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month");
}

function withInviteParam(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("invite", "true");
    return parsed.toString();
  } catch {
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}invite=true`;
  }
}

function formatLineDetailedMarkdown(title, isoStart, extProps) {
  const t = DateTime.fromISO(isoStart);
  const nycT = t.setZone(NYC).toFormat("hh:mm a");
  const ukT = t.setZone(UK).toFormat("hh:mm a");
  return `${nycT} NYC / ${ukT} UK - ${title} - [Sign Up](${signupUrl(extProps)})`;
}

function formatLineDetailedPlain(title, isoStart, extProps) {
  const t = DateTime.fromISO(isoStart);
  const nycT = t.setZone(NYC).toFormat("hh:mm a");
  const ukT = t.setZone(UK).toFormat("hh:mm a");
  const url = signupUrl(extProps);
  return `${nycT} NYC / ${ukT} UK - ${title} - [Sign Up](${url})`;
}

function formatLineCompactMarkdown(title, _isoStart, extProps) {
  return `[${title}](${signupUrl(extProps)})`;
}

function formatLineCompactPlain(title, _isoStart, extProps) {
  return `${title} (${signupUrl(extProps)})`;
}

function lineFormatter(markdown, style) {
  if (style === "daylink") return (title) => title;
  if (style === "compact") {
    return markdown ? formatLineCompactMarkdown : formatLineCompactPlain;
  }
  return markdown ? formatLineDetailedMarkdown : formatLineDetailedPlain;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableFetchError(err) {
  if (!err) return false;
  const code = err.cause?.code;
  const name = err.name;
  if (name === "AbortError") return true;
  if (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  const msg = String(err.message ?? "");
  if (/fetch failed/i.test(msg)) return true;
  return false;
}

async function fetchMeetings(projectSlug) {
  const base = process.env.PUBLIC_MEETINGS_API ?? DEFAULT_API;
  const url = `${base}/${encodeURIComponent(projectSlug)}?view=pcc`;
  const timeoutMs =
    Number.parseInt(process.env.FETCH_TIMEOUT_MS ?? "", 10) || 120000;
  const maxAttempts =
    Number.parseInt(process.env.FETCH_MAX_ATTEMPTS ?? "", 10) || 5;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);
      if (!res.ok)
        throw new Error(`Meetings HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const retry =
        isRetryableFetchError(err) && attempt < maxAttempts;
      if (!retry) throw err;
      const backoff = Math.min(45000, 4000 * 2 ** (attempt - 1));
      console.error(
        `Meeting API attempt ${attempt}/${maxAttempts} failed (${err?.cause?.code ?? err?.message ?? err}), waiting ${backoff}ms…`
      );
      await sleepMs(backoff);
    }
  }
  throw lastErr;
}

async function fetchPastMeetingsForRange(projectSlug, startDateNyc, endDateNyc) {
  const base =
    process.env.PUBLIC_MEETINGS_API ??
    DEFAULT_API;
  const apiRoot = base.replace(/\/$/, "").replace(/\/public\/meetings$/, "");
  const pastUrl =
    `${apiRoot}/public/meetings/${encodeURIComponent(projectSlug)}` +
    `/past?start_date=${encodeURIComponent(startDateNyc)}&end_date=${encodeURIComponent(endDateNyc)}`;

  // Reuse the same resilience knobs as primary meetings fetch.
  const timeoutMs =
    Number.parseInt(process.env.FETCH_TIMEOUT_MS ?? "", 10) || 120000;
  const maxAttempts =
    Number.parseInt(process.env.FETCH_MAX_ATTEMPTS ?? "", 10) || 5;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(pastUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);
      if (!res.ok)
        throw new Error(`Past meetings HTTP ${res.status}: ${await res.text()}`);
      const payload = await res.json();
      if (Array.isArray(payload?.meetings)) return payload.meetings;
      if (Array.isArray(payload)) return payload;
      return [];
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const retry = isRetryableFetchError(err) && attempt < maxAttempts;
      if (!retry) throw err;
      const backoff = Math.min(45000, 4000 * 2 ** (attempt - 1));
      console.error(
        `Past meetings attempt ${attempt}/${maxAttempts} failed (${err?.cause?.code ?? err?.message ?? err}), waiting ${backoff}ms…`
      );
      await sleepMs(backoff);
    }
  }
  throw lastErr;
}

async function loadWeekCache(cachePath, currentWeekStartIso) {
  if (!cachePath) return [];
  try {
    const raw = await readFile(resolve(cachePath), "utf8");
    const parsed = JSON.parse(raw);
    // Drop last week's cache as soon as NYC Monday rolls forward.
    if (typeof parsed?.weekStart !== "string") {
      console.error("Week cache missing weekStart; ignoring (will repopulate).");
      return [];
    }
    if (parsed.weekStart !== currentWeekStartIso) {
      console.error(
        `Week cache is for ${parsed.weekStart}, current week starts ${currentWeekStartIso}; ignoring.`
      );
      return [];
    }
    return Array.isArray(parsed?.meetings) ? parsed.meetings : [];
  } catch {
    return [];
  }
}

async function saveWeekCache(cachePath, meetings, weekStartIso, weekEndIso) {
  if (!cachePath) return;
  const abs = resolve(cachePath);
  await mkdir(dirname(abs), { recursive: true });
  const payload = {
    weekStart: weekStartIso,
    weekEnd: weekEndIso,
    updatedAt: DateTime.now().toISO(),
    meetings,
  };
  await writeFile(abs, JSON.stringify(payload, null, 2), "utf8");
}

function buildDigest(
  meetings,
  rangeStartNyc,
  rangeEndExclusiveNyc,
  markdown,
  {
    fixedMondayIsoDates = null,
    monthStartNyc = null,
    monthEndNyc = null,
    style = "detailed",
  } = {}
) {
  const fmtLine = lineFormatter(markdown, style);

  const activeWeekMondays = new Set();
  if (fixedMondayIsoDates) {
    for (const iso of fixedMondayIsoDates) activeWeekMondays.add(iso);
  } else {
    for (const m of meetings) {
      if (!m?.start || !m?.title) continue;
      const nycDay = DateTime.fromISO(m.start).setZone(NYC);
      if (nycDay < monthStartNyc || nycDay >= monthEndNyc) continue;
      activeWeekMondays.add(mondayMidnightSameIsoWeek(nycDay).toISODate());
    }
  }

  const weeks = new Map();
  for (const m of meetings) {
    if (!m?.start || !m?.title) continue;
    const nycDay = DateTime.fromISO(m.start).setZone(NYC);
    if (nycDay < rangeStartNyc || nycDay >= rangeEndExclusiveNyc) continue;

    const monday = mondayMidnightSameIsoWeek(nycDay);
    const mondayKey = monday.toISODate();
    if (!activeWeekMondays.has(mondayKey)) continue;

    let w = weeks.get(mondayKey);
    if (!w) {
      w = { sortKey: monday, lines: {} };
      weeks.set(mondayKey, w);
    }

    const dayKey = nycDay.toFormat("yyyy-MM-dd");
    if (!w.lines[dayKey]) {
      w.lines[dayKey] = { events: [] };
    }

    const extProps =
      m.extendedProps && typeof m.extendedProps === "object" ? m.extendedProps : {};
    w.lines[dayKey].events.push({ iso: m.start, title: m.title, extProps });
  }

  const sortedWeekKeys = fixedMondayIsoDates
    ? fixedMondayIsoDates
    : [...weeks.keys()].sort(
        (a, b) => weeks.get(a).sortKey.toMillis() - weeks.get(b).sortKey.toMillis()
      );

  const blocks = [];
  for (const wk of sortedWeekKeys) {
    const monday = DateTime.fromISO(wk, { zone: NYC });
    const w = weeks.get(wk) ?? { sortKey: monday, lines: {} };
    const parts = [];
    parts.push(
      fixedMondayIsoDates
        ? `### ${formatWeekRangeTitle(monday)}`
        : "This Week At FINOS"
    );
    parts.push("");
    let emittedDay = false;
    for (let offset = 0; offset < 7; offset += 1) {
      const day = monday.plus({ days: offset });
      const dk = day.toFormat("yyyy-MM-dd");
      const events = [...(w.lines[dk]?.events ?? [])];
      events.sort(
        (a, b) => DateTime.fromISO(a.iso).toMillis() - DateTime.fromISO(b.iso).toMillis()
      );
      if (style === "daylink" && events.length === 0) continue;
      emittedDay = true;
      const dayLabel = day.toFormat("cccc, LLLL d");
      if (style === "daylink") {
        const url = finosDayUrl(dk);
        parts.push(markdown ? `[${dayLabel}](${url})` : `${dayLabel} (${url})`);
      } else {
        parts.push(dayLabel);
      }
      for (const e of events) parts.push(fmtLine(e.title, e.iso, e.extProps));
      parts.push("");
    }
    if (style === "daylink" && !emittedDay) {
      parts.push("No meetings scheduled.");
      parts.push("");
    }
    blocks.push(parts.join("\n").trimEnd());
  }

  if (fixedMondayIsoDates) return blocks.join("\n\n");
  return blocks.filter((b) => b.split("\n").length > 2).join("\n\n");
}

async function main() {
  const explicitMonth = parseExplicitMonthArg(process.argv);
  const slug = process.env.PROJECT_SLUG ?? "finos";
  const outPath = process.env.OUTPUT ?? "";
  const outHtmlPath = process.env.OUTPUT_HTML ?? "";
  const weekCachePath = process.env.WEEK_CACHE_PATH ?? "";
  const markdown = process.env.FORMAT !== "plain";

  const nowNyc = DateTime.now().setZone(NYC);
  const thisMonday = mondayMidnightSameIsoWeek(nowNyc);

  let rangeStartNyc;
  let rangeEndExclusiveNyc;
  let fixedMondayIsoDates = null;
  let monthStartNyc = null;
  let monthEndNyc = null;

  if (explicitMonth) {
    const bounds = monthBoundsNyc(explicitMonth);
    monthStartNyc = bounds.start;
    monthEndNyc = bounds.end;
    rangeStartNyc = monthStartNyc;
    rangeEndExclusiveNyc = monthEndNyc;
  } else {
    const previousMonday = thisMonday.minus({ weeks: 1 });
    const nextSunday = thisMonday.plus({ weeks: 1, days: 6 }).endOf("day");
    rangeStartNyc = previousMonday;
    rangeEndExclusiveNyc = nextSunday.plus({ days: 1 }).startOf("day");
    fixedMondayIsoDates = [-1, 0, 1].map((i) =>
      thisMonday.plus({ weeks: i }).toISODate()
    );
  }

  const digestWindowLabel = fixedMondayIsoDates
    ? formatNycDaySpan(rangeStartNyc, rangeEndExclusiveNyc.minus({ days: 1 }))
    : monthStartNyc.toFormat("LLLL yyyy");

  console.error(
    fixedMondayIsoDates
      ? `Fetching public meetings for ${slug} (${digestWindowLabel}, previous/current/next NYC weeks)…`
      : `Fetching public meetings for ${slug} (${digestWindowLabel}, month bounds ${NYC})…`
  );

  const data = await fetchMeetings(slug);
  const meetings = Array.isArray(data?.meetings) ? data.meetings : [];

  // LFX public feed can hide completed meetings. Merge /past for the rolling
  // window (previous + current week) or the live month when rendering it.
  const runPastAndCacheMerge =
    fixedMondayIsoDates || monthStartNyc.hasSame(nowNyc, "month");
  if (runPastAndCacheMerge) {
    const weekStart = thisMonday;
    const weekEnd = weekStart.plus({ days: 6 }).endOf("day");
    const pastStart = fixedMondayIsoDates ? weekStart.minus({ weeks: 1 }) : weekStart;
    const weekStartNyc = weekStart.toISODate();
    const pastStartNyc = pastStart.toISODate();
    const weekEndNyc = nowNyc.toISODate();
    const weekEndFullIso = weekEnd.toISODate();
    try {
      const pastMeetings = await fetchPastMeetingsForRange(
        slug,
        pastStartNyc,
        weekEndNyc
      );
      const seen = new Set(meetings.map((m) => `${m?.id ?? ""}|${m?.start ?? ""}`));
      for (const pm of pastMeetings) {
        const k = `${pm?.id ?? ""}|${pm?.start ?? ""}`;
        if (!seen.has(k)) {
          meetings.push(pm);
          seen.add(k);
        }
      }
      if (pastMeetings.length > 0) {
        console.error(
          `Merged ${pastMeetings.length} past meetings from ${pastStartNyc}..${weekEndNyc} (${NYC}).`
        );
      }
    } catch (err) {
      // Non-fatal: keep normal output even if past endpoint is unavailable.
      console.error(`Past meetings fetch skipped: ${err?.message ?? err}`);
    }

    // Merge persistent cache as a fallback when upstream removes prior week days.
    const cachedMeetings = await loadWeekCache(weekCachePath, weekStartNyc);
    if (cachedMeetings.length > 0) {
      const seen = new Set(meetings.map((m) => `${m?.id ?? ""}|${m?.start ?? ""}`));
      let mergedCount = 0;
      for (const cm of cachedMeetings) {
        if (!cm?.start) continue;
        const t = DateTime.fromISO(cm.start).setZone(NYC);
        if (t < weekStart || t > weekEnd) continue;
        const k = `${cm?.id ?? ""}|${cm?.start ?? ""}`;
        if (!seen.has(k)) {
          meetings.push(cm);
          seen.add(k);
          mergedCount += 1;
        }
      }
      if (mergedCount > 0) {
        console.error(`Merged ${mergedCount} meetings from persistent current-week cache.`);
      }
    }

    // Refresh cache for the current NYC week only.
    const cacheWeekMeetings = meetings.filter((m) => {
      if (!m?.start) return false;
      const t = DateTime.fromISO(m.start).setZone(NYC);
      return t >= weekStart && t <= weekEnd;
    });
    await saveWeekCache(weekCachePath, cacheWeekMeetings, weekStartNyc, weekEndFullIso);
    if (weekCachePath) {
      console.error(
        `Saved current-week cache (${cacheWeekMeetings.length} meetings) to ${resolve(weekCachePath)}.`
      );
    }
  }

  const digestOpts = { fixedMondayIsoDates, monthStartNyc, monthEndNyc };
  let detailedDigest = buildDigest(
    meetings,
    rangeStartNyc,
    rangeEndExclusiveNyc,
    markdown,
    { ...digestOpts, style: "detailed" }
  );
  let compactDigest = buildDigest(
    meetings,
    rangeStartNyc,
    rangeEndExclusiveNyc,
    markdown,
    { ...digestOpts, style: "compact" }
  );
  let dayLinkDigest = buildDigest(
    meetings,
    rangeStartNyc,
    rangeEndExclusiveNyc,
    markdown,
    { ...digestOpts, style: "daylink" }
  );

  const emptyNote = fixedMondayIsoDates
    ? `_No FINOS meetings in ${digestWindowLabel} (${NYC}, three-week window)._`
    : `_No FINOS meetings in ${monthStartNyc.toFormat("LLLL yyyy")} (${NYC} month boundaries)._`;
  if (!detailedDigest) detailedDigest = emptyNote;
  if (!compactDigest) compactDigest = emptyNote;
  if (!dayLinkDigest) dayLinkDigest = emptyNote;

  const header = markdown
    ? fixedMondayIsoDates
      ? `## FINOS calendar — ${digestWindowLabel}\n\n` +
        `Rolling view: previous, current, and next NYC week (Monday–Sunday). ` +
        `Source: [FINOS meetings (month)](https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month).\n`
      : `## FINOS calendar — ${monthStartNyc.toFormat(
          "LLLL yyyy"
        )}\n\nSource: [FINOS meetings (month)](https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month).\n`
    : fixedMondayIsoDates
      ? `FINOS calendar — ${digestWindowLabel}\n\n` +
        `Rolling view: previous, current, and next NYC week (Monday–Sunday). ` +
        `Source: https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month\n`
      : `FINOS calendar — ${monthStartNyc.toFormat(
          "LLLL yyyy"
        )}\n\nSource: https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month\n`;

  // Markdown / plain: stack all formats. HTML gets a tab switcher instead.
  const full =
    `${header}\n` +
    (markdown ? `## With times\n\n` : `With times\n\n`) +
    `${detailedDigest}\n\n` +
    (markdown ? `## Titles only\n\n` : `Titles only\n\n`) +
    `${compactDigest}\n\n` +
    (markdown ? `## Day links\n\n` : `Day links\n\n`) +
    `${dayLinkDigest}\n`;

  // HTML uses the shared header once, then each digest without the section H2 wrappers.
  const detailedForHtml = `${header}\n${detailedDigest}\n`;
  const compactForHtml = `${header}\n${compactDigest}\n`;
  const dayLinkForHtml = `${header}\n${dayLinkDigest}\n`;

  process.stdout.write(full);

  if (outPath) {
    const abs = resolve(outPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, full, "utf8");
    console.error(`Wrote ${abs}`);
  }

  if (outHtmlPath) {
    const absHtml = resolve(outHtmlPath);
    await mkdir(dirname(absHtml), { recursive: true });
    await writeFile(
      absHtml,
      markdownToHtml(detailedForHtml, compactForHtml, dayLinkForHtml),
      "utf8"
    );
    console.error(`Wrote ${absHtml}`);
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(summaryFile, full);
  }
}

main().catch((e) => {
  console.error(e);
  exit(1);
});
