export type UsageBucket = 'unused' | 'rare' | 'regular';

/** Usage bucket relative to the scan window (eng Q1): rare means at most one use per ten sessions. */
export function usageBucket(uses: number, sessionsInWindow: number): UsageBucket {
  if (uses <= 0) return 'unused';
  return uses <= sessionsInWindow / 10 ? 'rare' : 'regular';
}
