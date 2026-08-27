import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  trend,
  trendTone = 'neutral',
  icon,
  iconBg,
}: {
  label: string;
  value: ReactNode;
  trend?: string;
  trendTone?: 'success' | 'danger' | 'neutral';
  icon: ReactNode;
  iconBg: string;
}) {
  const trendColor =
    trendTone === 'success'
      ? 'text-[oklch(50%_0.12_150)]'
      : trendTone === 'danger'
        ? 'text-[oklch(55%_0.15_25)]'
        : 'text-slate-500';

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-md" style={{ background: iconBg }}>
          {icon}
        </span>
      </div>
      <span className="font-mono text-[26px] font-semibold text-slate-900">{value}</span>
      {trend && <span className={`text-xs ${trendColor}`}>{trend}</span>}
    </div>
  );
}
