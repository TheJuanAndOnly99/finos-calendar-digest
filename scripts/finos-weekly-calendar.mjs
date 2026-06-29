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
  return /^\d{1,2}:\d{2} [AP]M NYC /.test(line);
}

function isDayHeading(line) {
  return /^[A-Za-z]+, [A-Za-z]+ \d+$/.test(line);
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

function markdownToHtml(markdown) {
  const escaped = markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const withLinks = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  const lines = withLinks.split("\n");
  const out = [];
  const inList = { value: false };
  const inWeek = { value: false };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    if (!line.trim()) {
      closeList(out, inList);
      continue;
    }

    if (line.startsWith("## ")) {
      closeList(out, inList);
      closeWeek(out, inWeek);
      out.push(`<h2>${line.slice(3)}</h2>`);
      continue;
    }

    if (isWeekHeading(line)) {
      closeList(out, inList);
      closeWeek(out, inWeek);
      out.push('<section class="week">');
      inWeek.value = true;
      const title = line.startsWith("### ") ? line.slice(4) : line;
      out.push(`<h3>${title}</h3>`);
      continue;
    }

    if (isDayHeading(line)) {
      closeList(out, inList);
      out.push(`<h4>${line}</h4>`);
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (!next || !isMeetingLine(next)) {
        out.push('<p class="empty-day">No meetings scheduled.</p>');
      }
      continue;
    }

    if (isMeetingLine(line)) {
      if (!inList.value) {
        out.push("<ul>");
        inList.value = true;
      }
      out.push(`<li>${line}</li>`);
      continue;
    }

    closeList(out, inList);
    out.push(`<p class="intro">${line}</p>`);
  }

  closeList(out, inList);
  closeWeek(out, inWeek);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FINOS Calendar Digest</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 980px; margin: 24px auto; line-height: 1.5; padding: 0 16px; color: #1a1a1a; }
    h2 { margin: 0 0 12px; font-size: 1.75rem; }
    .intro { margin: 0 0 24px; color: #444; }
    .week { margin: 32px 0; padding: 20px 0 8px; border-top: 1px solid #ddd; }
    .week:first-of-type { border-top: none; padding-top: 0; }
    h3 { margin: 0 0 16px; font-size: 1.25rem; }
    h4 { margin: 20px 0 8px; font-size: 1rem; color: #333; }
    ul { margin: 0 0 8px; padding-left: 1.25rem; }
    li { margin: 6px 0; }
    .empty-day { margin: 0 0 8px; color: #888; font-size: 0.95rem; font-style: italic; }
    a { color: #0b5fff; }
  </style>
</head>
<body>
${out.join("\n")}
</body>
</html>
`;
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

function formatLineMarkdown(title, isoStart, extProps) {
  const t = DateTime.fromISO(isoStart);
  const nycT = t.setZone(NYC).toFormat("hh:mm a");
  const ukT = t.setZone(UK).toFormat("hh:mm a");
  return `${nycT} NYC / ${ukT} UK - ${title} - [Sign Up](${signupUrl(extProps)})`;
}

function formatLinePlain(title, isoStart, extProps) {
  const t = DateTime.fromISO(isoStart);
  const nycT = t.setZone(NYC).toFormat("hh:mm a");
  const ukT = t.setZone(UK).toFormat("hh:mm a");
  const url = signupUrl(extProps);
  return `${nycT} NYC / ${ukT} UK - ${title} - [Sign Up](${url})`;
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
  { fixedMondayIsoDates = null, monthStartNyc = null, monthEndNyc = null } = {}
) {
  const fmtLine = markdown ? formatLineMarkdown : formatLinePlain;

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
    for (let offset = 0; offset < 7; offset += 1) {
      const day = monday.plus({ days: offset });
      const dk = day.toFormat("yyyy-MM-dd");
      parts.push(day.toFormat("cccc, LLLL d"));
      const events = w.lines[dk]?.events ?? [];
      events.sort(
        (a, b) => DateTime.fromISO(a.iso).toMillis() - DateTime.fromISO(b.iso).toMillis()
      );
      for (const e of events) parts.push(fmtLine(e.title, e.iso, e.extProps));
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

  let digest = buildDigest(meetings, rangeStartNyc, rangeEndExclusiveNyc, markdown, {
    fixedMondayIsoDates,
    monthStartNyc,
    monthEndNyc,
  });
  if (!digest) {
    digest = fixedMondayIsoDates
      ? `_No FINOS meetings in ${digestWindowLabel} (${NYC}, three-week window)._`
      : `_No FINOS meetings in ${monthStartNyc.toFormat("LLLL yyyy")} (${NYC} month boundaries)._`;
  }

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

  const full = `${header}\n${digest}\n`;
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
    await writeFile(absHtml, markdownToHtml(full), "utf8");
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
