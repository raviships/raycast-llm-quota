export type ProviderId = "codex" | "grok";

export type QuotaWindow = {
  label: string;
  usedPercent: number;
  resetsAt?: number;
};

export type ProviderQuota = {
  id: ProviderId;
  fetchedAt: number;
  windows: QuotaWindow[];
  bankedResets?: number;
  bankedResetExpiries?: Array<number | null>;
};

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function remainingPercent(usedPercent: number): number {
  return 100 - clampPercent(usedPercent);
}

export function windowLabel(durationMinutes?: number | null): string {
  if (!durationMinutes) return "Usage";
  if (durationMinutes === 300) return "5-hour";
  if (durationMinutes === 10_080) return "Weekly";
  if (durationMinutes === 43_200 || durationMinutes === 44_640) return "Monthly";
  if (durationMinutes % 1_440 === 0) return `${durationMinutes / 1_440}-day`;
  if (durationMinutes % 60 === 0) return `${durationMinutes / 60}-hour`;
  return "Usage";
}
