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

/** A column of `disjointAssignment`: a start instant on one resource (e.g. a doctor). */
export interface IntervalColumn {
  /** Columns of the same group must not receive overlapping intervals. */
  group: string;
  start: number;
}

export interface DisjointAssignmentResult extends AssignmentResult {
  /** Number of solver runs (1 when the first matching was already disjoint). */
  rounds: number;
}

/**
 * Min-cost assignment where row `i` placed on column `j` occupies
 * [columns[j].start, columns[j].start + durations[i]) and the occupied intervals
 * of one group must be pairwise disjoint (a slot grid guarantees distinct starts,
 * not disjoint ranges: a 60-minute appointment on a 30-minute grid collides with
 * its neighbour).
 *
 * Repair loop: solve; for every overlapping pair in a group keep one placement
 * (the winner: already pinned, else the one ending first, else the cheaper one),
 * pin it to its column and forbid, for every OTHER row,
 * every column of that group whose interval would overlap the winner's
 * [start, end); re-solve until no conflict is left. Each round forbids at least the loser's current edge, so the
 * loop converges; it is bounded by the number of columns, and any conflict that
 * survives the bound is resolved by leaving the costlier row unmatched. The input
 * matrix is not modified.
 */
export function disjointAssignment(
  costMatrix: readonly (readonly number[])[],
  durations: readonly number[],
  columns: readonly IntervalColumn[],
  maxRounds = Math.max(1, columns.length),
): DisjointAssignmentResult {
  const matrix = costMatrix.map((row) => [...row]);
  const n = matrix.length;
  let assignment: number[] = Array.from({ length: n }, (): number => -1);
  let rounds = 0;

  type Placed = { row: number; col: number; start: number; end: number; cost: number };
  const placedByGroup = (a: readonly number[]) => {
    const byGroup = new Map<string, Placed[]>();
    a.forEach((col, row) => {
      if (col < 0) return;
      const c = columns[col];
      const p: Placed = { row, col, start: c.start, end: c.start + durations[row], cost: costMatrix[row][col] };
      const list = byGroup.get(c.group);
      if (list) list.push(p);
      else byGroup.set(c.group, [p]);
    });
    for (const list of byGroup.values()) list.sort((x, y) => x.start - y.start || x.cost - y.cost || x.row - y.row);
    return byGroup;
  };
  // The winner keeps its column (pinned) and its interval becomes exclusive to it,
  // so the reserved time is never left empty by a later re-solve.
  const pinned = new Set<number>();
  const reserve = (winner: Placed, group: string) => {
    if (pinned.has(winner.row)) return;
    pinned.add(winner.row);
    for (let col = 0; col < columns.length; col++) {
      if (col !== winner.col) matrix[winner.row][col] = Infinity;
      const c = columns[col];
      if (c.group !== group || c.start >= winner.end) continue;
      for (let row = 0; row < n; row++) {
        if (pinned.has(row)) continue;
        if (c.start + durations[row] > winner.start) matrix[row][col] = Infinity;
      }
    }
  };
  // A pinned placement always wins; otherwise the one ending first (the
  // earliest-end rule of interval scheduling packs the most placements into the
  // group), then the cheaper one.
  const winnerOf = (a: Placed, b: Placed): Placed => {
    if (pinned.has(a.row) !== pinned.has(b.row)) return pinned.has(a.row) ? a : b;
    if (a.end !== b.end) return a.end < b.end ? a : b;
    return a.cost <= b.cost ? a : b;
  };

  while (rounds < maxRounds) {
    rounds++;
    assignment = minCostAssignment(matrix).assignment;
    let conflict = false;
    for (const [group, list] of placedByGroup(assignment)) {
      let kept: Placed | null = null;
      for (const cur of list) {
        if (kept && kept.end > cur.start) {
          conflict = true;
          const winner = winnerOf(kept, cur);
          reserve(winner, group);
          kept = winner;
        } else {
          kept = cur;
        }
      }
    }
    if (!conflict) break;
  }

  // Safety net (only reached when the bound was hit): drop the costlier row of any remaining overlap.
  for (const list of placedByGroup(assignment).values()) {
    let kept: Placed | null = null;
    for (const cur of list) {
      if (kept && kept.end > cur.start) {
        const loser = winnerOf(kept, cur) === kept ? cur : kept;
        assignment[loser.row] = -1;
        if (loser === kept) kept = cur;
      } else {
        kept = cur;
      }
    }
  }

  let totalCost = 0;
  let matched = 0;
  assignment.forEach((col, row) => {
    if (col < 0) return;
    totalCost += costMatrix[row][col];
    matched++;
  });
  return { assignment, totalCost, matched, rounds };
}
