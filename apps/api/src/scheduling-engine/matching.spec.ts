import { assignmentObjective, minCostAssignment } from './matching.js';

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
