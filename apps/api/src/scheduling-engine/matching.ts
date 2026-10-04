/**
 * Minimum-cost bipartite assignment for rectangular cost matrices.
 *
 * Rows are "tasks" (e.g. displaced appointments), columns are "slots". A cost of
 * `Infinity` marks a forbidden pair. The solver returns, among all assignments of
 * MAXIMUM cardinality (as many rows matched as the forbidden structure allows),
 * one of MINIMUM total cost. Unmatched rows get `-1`.
 *
 * Implementation: successive shortest augmenting paths with dual potentials
 * (Hungarian algorithm in the Jonker–Volgenant / e-maxx formulation). Each row is
 * inserted by one Dijkstra-like scan over the columns, giving O(n² · m) for n rows
 * and m columns. The matrix is padded with n "dummy" columns whose cost is a
 * penalty larger than any finite sum, so leaving a row unmatched is always more
 * expensive than matching it; forbidden pairs get an even larger finite cost so
 * the potentials stay finite. Dummy or forbidden picks are reported as `-1`.
 *
 * Pure: no allocation besides the O(n + m) working arrays.
 */

export interface AssignmentResult {
  /** assignment[row] = column index, or -1 when the row stays unmatched. */
  assignment: number[];
  /** Sum of the finite costs of the matched pairs. */
  totalCost: number;
  /** Number of matched rows. */
  matched: number;
}

export function minCostAssignment(costMatrix: readonly (readonly number[])[]): AssignmentResult {
  const n = costMatrix.length;
  const m = n === 0 ? 0 : Math.max(0, ...costMatrix.map((r) => r.length));
  if (n === 0) return { assignment: [], totalCost: 0, matched: 0 };

  // Penalty for an unmatched row: larger than any difference between finite sums.
  let finiteSum = 0;
  for (const row of costMatrix) {
    for (const c of row) {
      if (Number.isFinite(c)) finiteSum += Math.abs(c);
    }
  }
  const UNMATCHED = finiteSum + 1;
  const FORBIDDEN = 2 * UNMATCHED;

  // Columns 1..m are real, m+1..m+n are dummies (one per row), index 0 is the sentinel.
  const cols = m + n;
  const cost = (i: number, j: number): number => {
    if (j > m) return UNMATCHED;
    const c = costMatrix[i - 1][j - 1];
    return c === undefined || !Number.isFinite(c) ? FORBIDDEN : c;
  };

  const u = new Float64Array(n + 1); // row potentials
  const v = new Float64Array(cols + 1); // column potentials
  const p = new Int32Array(cols + 1); // p[j] = row matched to column j (0 = free)
  const way = new Int32Array(cols + 1);
  const minv = new Float64Array(cols + 1);
  const used = new Uint8Array(cols + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const cur = cost(i0, j) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // Augment along the alternating path.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = Array.from({ length: n }, (): number => -1);
  let totalCost = 0;
  let matched = 0;
  for (let j = 1; j <= m; j++) {
    const i = p[j];
    if (i === 0) continue;
    const c = costMatrix[i - 1][j - 1];
    if (c === undefined || !Number.isFinite(c)) continue; // forbidden pick ≡ unmatched
    assignment[i - 1] = j - 1;
    totalCost += c;
    matched++;
  }
  return { assignment, totalCost, matched };
}

/** Objective used by the solver (and by brute-force checks): finite cost plus a penalty per unmatched row. */
export function assignmentObjective(costMatrix: readonly (readonly number[])[], assignment: readonly number[], unmatchedPenalty: number): number {
  let total = 0;
  for (let i = 0; i < assignment.length; i++) {
    const j = assignment[i];
    if (j < 0) total += unmatchedPenalty;
    else total += costMatrix[i][j];
  }
  return total;
}
