/** No-show risk thresholds (docs/SCHEDULING.md §7): ≥0.5 amber "At risk", ≥0.75 red "High risk". */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';
export interface RiskView { level: RiskLevel; label: string; color: 'gray' | 'green' | 'amber' | 'red'; percent: number | null; }

export const RISK_AT = 0.5;
export const RISK_HIGH = 0.75;

export function riskLevel(risk: number | null | undefined): RiskLevel {
  if (risk === null || risk === undefined || Number.isNaN(risk)) return 'none';
  if (risk >= RISK_HIGH) return 'high';
  if (risk >= RISK_AT) return 'medium';
  return 'low';
}

export function riskView(risk: number | null | undefined): RiskView {
  const level = riskLevel(risk);
  const percent = level === 'none' ? null : Math.round(Math.min(1, Math.max(0, risk!)) * 100);
  switch (level) {
    case 'high': return { level, label: 'High risk', color: 'red', percent };
    case 'medium': return { level, label: 'At risk', color: 'amber', percent };
    case 'low': return { level, label: 'Low risk', color: 'green', percent };
    default: return { level, label: 'No score', color: 'gray', percent };
  }
}
