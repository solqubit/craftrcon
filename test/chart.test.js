import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAP_MS, niceTicks, nearestPoint, summarize, timeTicks, toAreaPath, toPath } from '../public/js/lib/chart.js';

const MIN = 60_000;
const at = (m, online = 1) => ({ ts: m * MIN, online, max: 20 });

test('niceTicks: integer ticks from 0 with a nice step, topping the data', () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(1), [0, 1]);
  assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(4), [0, 1, 2, 3, 4]);
  assert.deepEqual(niceTicks(12), [0, 5, 10, 15]);
  assert.deepEqual(niceTicks(50), [0, 20, 40, 60]);
  assert.deepEqual(niceTicks(100), [0, 50, 100]);
  assert.deepEqual(niceTicks(250), [0, 100, 200, 300]);
});

test('niceTicks: always integers, ascending, covering the maximum', () => {
  for (let max = 0; max <= 2000; max += 7) {
    const ticks = niceTicks(max);
    assert.ok(ticks.length >= 2 && ticks.length <= 6, `count for ${max}`);
    assert.ok(ticks.every(Number.isInteger), `integers for ${max}`);
    assert.ok(ticks.at(-1) >= max, `covers ${max}`);
    assert.equal(ticks[0], 0);
  }
});

test('niceTicks: tolerates junk', () => {
  assert.deepEqual(niceTicks(NaN), [0, 1]);
  assert.deepEqual(niceTicks(-5), [0, 1]);
  assert.deepEqual(niceTicks(2.2), [0, 1, 2, 3]);
});

test('toPath: scales to the box, y inverted, over the given x domain', () => {
  const points = [at(0, 0), at(1, 10), at(2, 5)];
  assert.equal(toPath(points, 200, 100, [0, 2 * MIN], 10), 'M0 100L100 0L200 50');
});

test('toPath: a gap longer than 3 minutes breaks the line', () => {
  const points = [at(0, 2), at(1, 2), at(5, 2), at(6, 2)];
  const d = toPath(points, 60, 10, [0, 6 * MIN], 2);
  assert.equal(d, 'M0 0L10 0M50 0L60 0');
  assert.equal(GAP_MS, 3 * MIN);
});

test('toPath: exactly 3 minutes apart still joins', () => {
  const d = toPath([at(0, 1), at(3, 1)], 30, 10, [0, 3 * MIN], 1);
  assert.equal(d, 'M0 0L30 0');
});

test('toPath: a lone sample becomes a dot; no points an empty path', () => {
  assert.equal(toPath([at(1, 1)], 20, 10, [0, 2 * MIN], 1), 'M10 0L10 0');
  assert.equal(toPath([], 20, 10, [0, 2 * MIN], 1), '');
});

test('toPath: samples outside the domain are dropped', () => {
  const d = toPath([at(-5, 1), at(1, 1), at(9, 1)], 20, 10, [0, 2 * MIN], 1);
  assert.equal(d, 'M10 0L10 0');
});

test('toPath: a zero yMax does not divide by zero', () => {
  assert.equal(toPath([at(0, 0), at(1, 0)], 10, 10, [0, MIN], 0), 'M0 10L10 10');
});

test('toAreaPath: closes every run down to the baseline', () => {
  const d = toAreaPath([at(0, 2), at(1, 2), at(6, 2)], 60, 10, [0, 6 * MIN], 2);
  assert.equal(d, 'M0 10L0 0L10 0L10 10ZM60 10L60 0L60 10Z');
});

test('nearestPoint: closest sample within the distance, else null', () => {
  const points = [at(0), at(1), at(2), at(10)];
  assert.equal(nearestPoint(points, 1.2 * MIN, GAP_MS), points[1]);
  assert.equal(nearestPoint(points, 1.6 * MIN, GAP_MS), points[2]);
  assert.equal(nearestPoint(points, 6 * MIN, GAP_MS), null);
  assert.equal(nearestPoint(points, 10.5 * MIN, GAP_MS), points[3]);
  assert.equal(nearestPoint([], 0, GAP_MS), null);
});

test('summarize: peak and latest', () => {
  assert.deepEqual(summarize([at(0, 3), at(1, 9), at(2, 4)]), { peak: 9, latest: 4, count: 3 });
  assert.deepEqual(summarize([]), { peak: 0, latest: 0, count: 0 });
});

test('timeTicks: 24 h ticks fall on local hours divisible by 4, inside the domain', () => {
  const to = new Date(2026, 5, 15, 13, 37).getTime();
  const from = to - 24 * 3600e3;
  const ticks = timeTicks([from, to]);
  assert.ok(ticks.length >= 5 && ticks.length <= 7, String(ticks.length));
  for (const ts of ticks) {
    assert.ok(ts >= from && ts <= to);
    const d = new Date(ts);
    assert.equal(d.getHours() % 4, 0);
    assert.equal(d.getMinutes(), 0);
  }
  assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
});

test('timeTicks: 7 d ticks fall on local midnights', () => {
  const to = new Date(2026, 5, 15, 13, 37).getTime();
  const from = to - 7 * 24 * 3600e3;
  const ticks = timeTicks([from, to]);
  assert.ok(ticks.length >= 7 && ticks.length <= 8, String(ticks.length));
  for (const ts of ticks) {
    assert.ok(ts >= from && ts <= to);
    const d = new Date(ts);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  }
});
