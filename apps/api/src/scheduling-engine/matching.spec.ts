import { assignmentObjective, disjointAssignment, minCostAssignment } from './matching.js';

/** Exhaustive search over every partial injective assignment (rows → distinct columns or -1). */
function bruteForce(cost: number[][]): { best: number; matched: number } {
  const n = cost.length;
  const m = n === 0 ? 0 : Math.max(0, ...cost.map((r) => r.length));
  let finiteSum = 0;
  for (const row of cost) for (const c of row) if (Number.isFinite(c)) finiteSum += Math.abs(c);
  const penalty = finiteSum + 1;
  const assignment = Array.from({ length: n }, (): number => -1);
  const usedCol = Array.from({ length: m }, (): boolean => false);
  let best = Infinity;
  let bestMatched = 0;
  const rec = (i: number) => {
    if (i === n) {
      const value = assignmentObjective(cost, assignment, penalty);
      if (value < best) {
        best = value;
        bestMatched = assignment.filter((j) => j >= 0).length;
      }
      return;
    }
    rec(i + 1); // row i unmatched
    for (let j = 0; j < m; j++) {
      if (usedCol[j] || !Number.isFinite(cost[i][j])) continue;
      usedCol[j] = true;
      assignment[i] = j;
      rec(i + 1);
      assignment[i] = -1;
      usedCol[j] = false;
    }
  };
  rec(0);
  return { best, matched: bestMatched };
}

function assertValid(cost: number[][], assignment: number[]) {
  const seen = new Set<number>();
  assignment.forEach((j, i) => {
    if (j < 0) return;
    expect(seen.has(j)).toBe(false);
    seen.add(j);
    expect(Number.isFinite(cost[i][j])).toBe(true);
  });
}

describe('minCostAssignment', () => {
  it('solves a classic square instance', () => {
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const r = minCostAssignment(cost);
    expect(r.assignment).toEqual([1, 0, 2]);
    expect(r.totalCost).toBe(5);
    expect(r.matched).toBe(3);
  });

  it('handles identity-like and reversed costs', () => {
    const cost = [
      [0, 10, 10],
      [10, 0, 10],
      [10, 10, 0],
    ];
    expect(minCostAssignment(cost)).toMatchObject({ assignment: [0, 1, 2], totalCost: 0 });
    const rev = [
      [10, 10, 0],
      [10, 0, 10],
      [0, 10, 10],
    ];
    expect(minCostAssignment(rev)).toMatchObject({ assignment: [2, 1, 0], totalCost: 0 });
  });

  it('respects forbidden edges and prefers matching more rows over a cheaper partial solution', () => {
    // Row 0 can only take column 0 (cheaply), row 1 could take column 0 cheaper but then row 0 is stranded.
    const cost = [
      [5, Infinity],
      [1, 100],
    ];
    const r = minCostAssignment(cost);
    expect(r.assignment).toEqual([0, 1]);
    expect(r.totalCost).toBe(105);
  });

  it('leaves rows unmatched when every edge is forbidden', () => {
    const cost = [
      [Infinity, Infinity],
      [1, Infinity],
      [Infinity, Infinity],
    ];
    const r = minCostAssignment(cost);
    expect(r.assignment).toEqual([-1, 0, -1]);
    expect(r.totalCost).toBe(1);
    expect(r.matched).toBe(1);
  });

  it('handles more rows than columns (some rows stay unmatched)', () => {
    const cost = [
      [3, 8],
      [1, 9],
      [2, 2],
      [7, 1],
    ];
    const r = minCostAssignment(cost);
    assertValid(cost, r.assignment);
    expect(r.matched).toBe(2);
    expect(r.totalCost).toBe(2); // rows 1→0 and 3→1
    expect(r.assignment).toEqual([-1, 0, -1, 1]);
  });

  it('handles more columns than rows', () => {
    const cost = [[9, 4, 7, 1]];
    expect(minCostAssignment(cost)).toEqual({ assignment: [3], totalCost: 1, matched: 1 });
  });

  it('handles degenerate shapes', () => {
    expect(minCostAssignment([])).toEqual({ assignment: [], totalCost: 0, matched: 0 });
    expect(minCostAssignment([[], []])).toEqual({ assignment: [-1, -1], totalCost: 0, matched: 0 });
  });

  it('accepts negative costs', () => {
    const cost = [
      [-5, 2],
      [-3, -4],
    ];
    expect(minCostAssignment(cost)).toMatchObject({ assignment: [0, 1], totalCost: -9 });
  });

  it('matches a brute-force search on random 1..6 × 1..6 instances with forbidden edges (100 rounds)', () => {
    for (let round = 0; round < 100; round++) {
      const n = 1 + Math.floor(Math.random() * 6);
      const m = 1 + Math.floor(Math.random() * 6);
      const cost = Array.from({ length: n }, () =>
        Array.from({ length: m }, () => (Math.random() < 0.2 ? Infinity : Math.floor(Math.random() * 50) - 10)),
      );
      const r = minCostAssignment(cost);
      assertValid(cost, r.assignment);
      const expected = bruteForce(cost);
      expect(r.matched).toBe(expected.matched);
      let finiteSum = 0;
      for (const row of cost) for (const c of row) if (Number.isFinite(c)) finiteSum += Math.abs(c);
      expect(assignmentObjective(cost, r.assignment, finiteSum + 1)).toBe(expected.best);
      let total = 0;
      r.assignment.forEach((j, i) => {
        if (j >= 0) total += cost[i][j];
      });
      expect(r.totalCost).toBe(total);
    }
  });

  it('scales to a few hundred rows against two thousand columns', () => {
    const n = 150;
    const m = 2000;
    const cost = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => Math.abs(i * 13 - j) + (j % 7 === 0 ? 240 : 0)));
    const started = Date.now();
    const r = minCostAssignment(cost);
    expect(Date.now() - started).toBeLessThan(5000);
    assertValid(cost, r.assignment);
    expect(r.matched).toBe(n);
  });
});

describe('disjointAssignment', () => {
  const MIN = 60_000;
  const overlappingPairs = (assignment: number[], durations: number[], columns: { group: string; start: number }[]) => {
    const placed = assignment
      .map((col, row) => (col < 0 ? null : { group: columns[col].group, start: columns[col].start, end: columns[col].start + durations[row] }))
      .filter((p): p is { group: string; start: number; end: number } => p !== null)
      .sort((a, b) => a.group.localeCompare(b.group) || a.start - b.start);
    let pairs = 0;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        if (placed[i].group === placed[j].group && placed[i].start < placed[j].end && placed[j].start < placed[i].end) pairs++;
      }
    }
    return pairs;
  };

  it('places 8 back-to-back one-hour appointments on a 30-minute grid without overlaps (review repro)', () => {
    // Day 0: 8 one-hour appointments 09:00..17:00 displaced by a time off.
    const day0 = Date.UTC(2026, 10, 2, 9);
    const starts = Array.from({ length: 8 }, (_, i) => day0 + i * 60 * MIN);
    const durations = starts.map(() => 60 * MIN);
    // Day 1: one free 09:00–17:00 gap, 16 candidate starts every 30 minutes.
    const day1 = day0 + 24 * 60 * MIN;
    const gapEnd = day1 + 8 * 60 * MIN;
    const columns = Array.from({ length: 16 }, (_, k) => ({ group: 'd1', start: day1 + k * 30 * MIN }));
    const matrix = starts.map((s) => columns.map((c) => (c.start + 60 * MIN > gapEnd ? Infinity : Math.abs(c.start - s) / MIN + 60)));

    // The plain matching stacks them into the cheapest 4 hours (the bug the repair fixes).
    const plain = minCostAssignment(matrix).assignment;
    expect(overlappingPairs(plain, durations, columns)).toBeGreaterThan(0);

    const result = disjointAssignment(matrix, durations, columns);
    expect(overlappingPairs(result.assignment, durations, columns)).toBe(0);
    // The free day holds exactly 8 one-hour slots on the hour: all are placed.
    expect(result.matched).toBe(8);
    expect(result.assignment.map((c) => (columns[c].start - day1) / (60 * MIN)).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.rounds).toBeLessThanOrEqual(columns.length);
    // Every placement uses a distinct, permitted column inside the gap
    const used = result.assignment.filter((c) => c >= 0);
    expect(new Set(used).size).toBe(used.length);
    for (const [row, col] of result.assignment.entries()) if (col >= 0) expect(Number.isFinite(matrix[row][col])).toBe(true);
    // The input matrix is left untouched
    expect(matrix.every((row) => row.filter((c) => c === Infinity).length === 1)).toBe(true);
  });

  it('keeps disjoint matchings as they are and ignores overlaps across groups', () => {
    const columns = [
      { group: 'a', start: 0 },
      { group: 'b', start: 0 },
      { group: 'a', start: 60 },
    ];
    const matrix = [
      [1, 5, 9],
      [5, 1, 9],
      [9, 9, 1],
    ];
    const result = disjointAssignment(matrix, [60, 60, 60], columns);
    expect(result.assignment).toEqual([0, 1, 2]);
    expect(result.rounds).toBe(1);
    expect(result.totalCost).toBe(3);
  });

  it('never returns overlaps even when the round bound is hit', () => {
    const columns = Array.from({ length: 6 }, (_, k) => ({ group: 'g', start: k * 30 }));
    const matrix = Array.from({ length: 4 }, (_, r) => columns.map((c) => Math.abs(c.start - r * 10)));
    const durations = [60, 60, 60, 60];
    const result = disjointAssignment(matrix, durations, columns, 1);
    expect(overlappingPairs(result.assignment, durations, columns)).toBe(0);
  });
});
