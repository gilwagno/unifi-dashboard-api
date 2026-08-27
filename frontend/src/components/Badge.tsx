type Tone = 'success' | 'danger' | 'warning' | 'neutral';

const TONES: Record<Tone, string> = {
  success: 'text-[oklch(40%_0.13_150)] bg-[oklch(94%_0.05_150_/_0.5)]',
  danger: 'text-[oklch(45%_0.18_25)] bg-[oklch(95%_0.05_25_/_0.6)]',
  warning: 'text-[oklch(50%_0.13_80)] bg-[oklch(95%_0.08_80_/_0.6)]',
  neutral: 'text-slate-600 bg-slate-100',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-block w-fit rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}
