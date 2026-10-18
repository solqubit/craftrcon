// Geometry of the Dashboard's player chart: axis ticks and SVG paths for a
// series of { ts, online } samples. Pure functions, no DOM, so they can be
// unit-tested with node:test.

// Samples come once a minute while the server is online: a hole longer than
// this means it was offline (or the panel was down), so the line is broken
// there instead of drawing a misleading slope across it.
export const GAP_MS = 3 * 60_000;

const STEPS = [1, 2, 5];

// Integer Y ticks from 0 up to a nice number >= max, at most 5 of them:
// niceTicks(12) -> [0, 5, 10, 15].
export function niceTicks(max) {
  const top = Number.isFinite(max) && max > 0 ? Math.ceil(max) : 1;
  const wanted = top / 4;
  let step = 1;
  for (let power = 1; ; power *= 10) {
    const found = STEPS.map((s) => s * power).find((s) => s >= wanted);
    if (found !== undefined) {
      step = found;
      break;
    }
  }
  const ticks = [];
  for (let v = 0; v - step < top; v += step) ticks.push(v);
  return ticks;
}

const round = (n) => String(Math.round(n * 100) / 100);

// Samples inside the x domain, split into runs wherever two neighbours are
// more than `gapMs` apart.
function runsOf(points, [from, to], gapMs) {
  const runs = [];
  let run = null;
  let last = null;
  for (const p of points) {
    if (p.ts < from || p.ts > to) continue;
    if (run === null || p.ts - last > gapMs) {
      run = [];
      runs.push(run);
    }
    run.push(p);
    last = p.ts;
  }
  return runs;
}

function scales(w, h, [from, to], yMax) {
  const span = to - from || 1;
  return {
    x: (ts) => ((ts - from) / span) * w,
    y: (value) => (yMax > 0 ? h - (value / yMax) * h : h),
  };
}

// SVG path "d" of the line, in a w x h box: x spans `xDomain` ([from, to] in
// ms), y spans 0..yMax. One "M…L…" run per stretch of continuous samples; a
// run of one sample is drawn as a zero-length line (a dot with round caps).
export function toPath(points, w, h, xDomain, yMax, gapMs = GAP_MS) {
  const { x, y } = scales(w, h, xDomain, yMax);
  return runsOf(points, xDomain, gapMs)
    .map((run) => {
      const coords = run.map((p) => `${round(x(p.ts))} ${round(y(p.online))}`);
      return `M${coords[0]}${coords.length === 1 ? `L${coords[0]}` : coords.slice(1).map((c) => `L${c}`).join('')}`;
    })
    .join('');
}

// The same runs as closed shapes down to the baseline, for the fill under the line.
export function toAreaPath(points, w, h, xDomain, yMax, gapMs = GAP_MS) {
  const { x, y } = scales(w, h, xDomain, yMax);
  return runsOf(points, xDomain, gapMs)
    .map((run) => {
      const first = round(x(run[0].ts));
      const last = round(x(run.at(-1).ts));
      const line = run.map((p) => `L${round(x(p.ts))} ${round(y(p.online))}`).join('');
      return `M${first} ${round(h)}${line}L${last} ${round(h)}Z`;
    })
    .join('');
}

// The sample (ascending by ts) closest to `ts`, or null when none is within `maxDistance` ms.
export function nearestPoint(points, ts, maxDistance) {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  let best = points[lo];
  if (lo > 0 && ts - points[lo - 1].ts <= Math.abs(best.ts - ts)) best = points[lo - 1];
  return Math.abs(best.ts - ts) <= maxDistance ? best : null;
}

export function summarize(points) {
  let peak = 0;
  for (const p of points) peak = Math.max(peak, p.online);
  return { peak, latest: points.at(-1)?.online ?? 0, count: points.length };
}

const HOUR_MS = 3600e3;

// Timestamps for the X axis labels, in local time: every 4 hours (on hours
// divisible by 4) for spans up to two days, else every local midnight.
export function timeTicks([from, to]) {
  const ticks = [];
  const d = new Date(from);
  if (to - from > 48 * HOUR_MS) {
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < from) d.setDate(d.getDate() + 1);
    for (; d.getTime() <= to; d.setDate(d.getDate() + 1)) ticks.push(d.getTime());
  } else {
    d.setMinutes(0, 0, 0);
    while (d.getTime() < from || d.getHours() % 4 !== 0) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= to; d.setHours(d.getHours() + 4)) ticks.push(d.getTime());
  }
  return ticks;
}
