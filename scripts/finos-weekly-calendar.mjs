#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exit } from "node:process";
import { DateTime } from "luxon";

const NYC = "America/New_York";
const UK = "Europe/London";
const DEFAULT_API =
  "https://pcc-bff.platform.linuxfoundation.org/production/api/v2/itx-services/public/meetings";

function parseMonthArg(argv) {
  const i = argv.indexOf("--month");
  if (i !== -1 && argv[i + 1]) return argv[i + 1].trim();
  const env = process.env.MONTH?.trim();
  if (env) return env;
  return DateTime.now().setZone(NYC).toFormat("yyyy-MM");
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

function signupUrl(ext) {
  if (ext?.share_url) return ext.share_url;
  const id = ext?.meeting_id;
  if (id) return `https://zoom-lfx.platform.linuxfoundation.org/meeting/${id}`;
  return "https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month";
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
  return `${nycT} NYC / ${ukT} UK - ${title} - Sign Up (${url})`;
}

async function fetchMeetings(projectSlug, signal) {
  const base = process.env.PUBLIC_MEETINGS_API ?? DEFAULT_API;
  const url = `${base}/${encodeURIComponent(projectSlug)}?view=pcc`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Meetings HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function buildMonthlyDigest(meetings, monthStartNyc, monthEndNyc, markdown) {
  const fmtLine = markdown ? formatLineMarkdown : formatLinePlain;
  const weeks = new Map();

  for (const m of meetings) {
    if (!m?.start || !m?.title) continue;
    const ts = DateTime.fromISO(m.start);
    if (ts < monthStartNyc || ts >= monthEndNyc) continue;

    const nycDay = ts.setZone(NYC);
    const monday = mondayMidnightSameIsoWeek(nycDay);
    const mondayKey = monday.toISODate();
    let w = weeks.get(mondayKey);
    if (!w) {
      w = { sortKey: monday, lines: {} };
      weeks.set(mondayKey, w);
    }

    const dayKey = nycDay.toFormat("yyyy-MM-dd");
    if (!w.lines[dayKey]) {
      w.lines[dayKey] = { daySort: nycDay.startOf("day"), events: [] };
    }

    const extProps =
      m.extendedProps && typeof m.extendedProps === "object" ? m.extendedProps : {};
    w.lines[dayKey].events.push({ iso: m.start, title: m.title, extProps });
  }

  const sortedWeekKeys = [...weeks.keys()].sort((a, b) =>
    weeks.get(a).sortKey.toMillis() - weeks.get(b).sortKey.toMillis()
  );

  const blocks = [];
  for (const wk of sortedWeekKeys) {
    const w = weeks.get(wk);
    const dayKeys = Object.keys(w.lines).sort(
      (a, b) => w.lines[a].daySort.toMillis() - w.lines[b].daySort.toMillis()
    );
    const parts = [];
    parts.push("This Week At FINOS");
    parts.push("");
    for (const dk of dayKeys) {
      const { daySort, events } = w.lines[dk];
      parts.push(daySort.toFormat("cccc, LLLL d"));
      events.sort(
        (a, b) => DateTime.fromISO(a.iso).toMillis() - DateTime.fromISO(b.iso).toMillis()
      );
      for (const e of events) parts.push(fmtLine(e.title, e.iso, e.extProps));
      parts.push("");
    }
    blocks.push(parts.join("\n").trimEnd());
  }

  return blocks.filter((b) => b.split("\n").length > 2).join("\n\n");
}

async function main() {
  const monthStr = parseMonthArg(process.argv);
  const slug = process.env.PROJECT_SLUG ?? "finos";
  const outPath = process.env.OUTPUT ?? "";
  const markdown = process.env.FORMAT !== "plain";

  const { start: monthStartNyc, end: monthEndNyc } = monthBoundsNyc(monthStr);
  console.error(
    `Fetching public meetings for ${slug} (${monthStartNyc.toFormat("LLLL yyyy")}, month bounds ${NYC})…`
  );

  const data = await fetchMeetings(slug);
  const meetings = Array.isArray(data?.meetings) ? data.meetings : [];

  let digest = buildMonthlyDigest(meetings, monthStartNyc, monthEndNyc, markdown);
  if (!digest)
    digest = `_No FINOS meetings in ${monthStartNyc.toFormat("LLLL yyyy")} (${NYC} month boundaries)._`;

  const header = markdown
    ? `## FINOS calendar — ${monthStartNyc.toFormat(
        "LLLL yyyy"
      )}\n\nSource: [FINOS meetings (month)](https://zoom-lfx.platform.linuxfoundation.org/meetings/finos?view=month).\n`
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
