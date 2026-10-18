// Line chart of player counts over time, drawn as plain SVG (no library).
// `points` are { ts, online } samples ascending by time; `domain` is the
// [from, to] span in ms the X axis covers (a hole in the data is a stretch
// where the server was offline: the line breaks there). Hover or touch shows
// the sample under the pointer. Accessible as one image with a text summary.
import { html, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/htm-preact.js';
import { getLang, t } from '../i18n.js';
import { GAP_MS, nearestPoint, niceTicks, summarize, timeTicks, toAreaPath, toPath } from '../lib/chart.js';

const MARGIN = { top: 10, right: 14, bottom: 24, left: 34 };
const MIN_WIDTH = 240;
const LONG_SPAN_MS = 48 * 3600e3;
const LABEL_SLOT = 76; // px one X label needs

// Keeps every k-th tick so that at most `max` remain, evenly spread.
function thin(ticks, max) {
  if (ticks.length <= max) return ticks;
  const k = Math.ceil(ticks.length / max);
  return ticks.filter((_, i) => i % k === 0);
}

export function LineChart({ points, domain, height = 200 }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(null); // the sample under the pointer

  useLayoutEffect(() => {
    const el = wrapRef.current;
    const measure = () => setWidth(Math.max(MIN_WIDTH, Math.floor(el.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [from, to] = domain;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const lang = getLang();
  const long = to - from > LONG_SPAN_MS;

  const geometry = useMemo(() => {
    const peak = summarize(points).peak;
    const yTicks = niceTicks(peak);
    const yMax = yTicks.at(-1);
    return {
      yTicks,
      yMax,
      line: toPath(points, innerW, innerH, [from, to], yMax),
      area: toAreaPath(points, innerW, innerH, [from, to], yMax),
      xTicks: thin(timeTicks([from, to]), Math.max(1, Math.floor(innerW / LABEL_SLOT))),
    };
  }, [points, from, to, innerW, innerH]);

  const xOf = (ts) => ((ts - from) / (to - from || 1)) * innerW;
  const yOf = (value) => innerH - (value / geometry.yMax) * innerH;

  const tickLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(lang, long ? { weekday: 'short' } : { hour: '2-digit', minute: '2-digit' });
    return (ts) => format.format(ts);
  }, [lang, long]);
  const tipFormat = useMemo(
    () => new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    [lang],
  );

  function onPointerMove(event) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left - MARGIN.left;
    if (x < 0 || x > innerW) {
      setHover(null);
      return;
    }
    const found = nearestPoint(points, from + (x / innerW) * (to - from), GAP_MS);
    setHover((previous) => (previous === found ? previous : found));
  }

  const { peak, latest } = summarize(points);
  const label = t('dashboard.chart.summary', {
    range: t(long ? 'dashboard.chart.rangeName.7d' : 'dashboard.chart.rangeName.24h'),
    peak,
    latest,
  });
  const tipLeft = hover ? Math.min(Math.max(MARGIN.left + xOf(hover.ts), 70), width - 70) : 0;

  return html`<div class="lc" ref=${wrapRef} style=${{ height: `${height}px` }}>
    <svg class="lc-svg" width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${label} onPointerMove=${onPointerMove} onPointerLeave=${() => setHover(null)}>
      <g transform=${`translate(${MARGIN.left} ${MARGIN.top})`}>
        ${geometry.yTicks.map(
          (v) => html`<g key=${`y${v}`}>
            <line class="lc-grid" x1="0" x2=${innerW} y1=${yOf(v)} y2=${yOf(v)} />
            <text class="lc-label" x="-8" y=${yOf(v)} text-anchor="end" dominant-baseline="middle">${v}</text>
          </g>`,
        )}
        ${geometry.xTicks.map(
          (ts) => html`<text key=${`x${ts}`} class="lc-label" x=${xOf(ts)} y=${innerH + 17} text-anchor="middle">${tickLabel(ts)}</text>`,
        )}
        <path class="lc-area" d=${geometry.area} />
        <path class="lc-line" d=${geometry.line} />
        ${hover &&
        html`<line class="lc-guide" x1=${xOf(hover.ts)} x2=${xOf(hover.ts)} y1="0" y2=${innerH} />
          <circle class="lc-dot" cx=${xOf(hover.ts)} cy=${yOf(hover.online)} r="4" />`}
      </g>
    </svg>
    ${hover &&
    html`<div class="lc-tip" style=${{ left: `${tipLeft}px` }} aria-hidden="true">
      <strong>${t('dashboard.chart.tooltip', { count: hover.online })}</strong>
      <span>${tipFormat.format(hover.ts)}</span>
    </div>`}
  </div>`;
}
