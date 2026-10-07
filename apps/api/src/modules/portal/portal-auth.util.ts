/** Small pure helpers of the portal OTP flow. */

/** Waits until at least `minMs` have elapsed since `startedAt` (Date.now()), so fast and slow paths look alike. */
export async function padLatency(startedAt: number, minMs: number): Promise<void> {
  const remaining = minMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

/** "Sara Patient" → "S. P***": enough to tell candidates apart, not enough to learn who shares a phone. */
export function maskPatientName(firstName: string, lastName: string): string {
  const initial = (s: string) => Array.from(s.trim())[0]?.toUpperCase() ?? '';
  const first = initial(firstName);
  const last = initial(lastName);
  return [first ? `${first}.` : '', last ? `${last}***` : ''].filter(Boolean).join(' ') || '***';
}
