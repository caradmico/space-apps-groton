import type { Metadata } from "next";

export const metadata: Metadata = { title: "Schedule" };

const day1 = [
  ["09:00", "Doors · welcome · access / logistics"],
  ["09:30", "Team formation · no coding required"],
  ["10:00–12:00", "Hacking"],
  ["12:00–13:00", "Lunch break (plan TBD — do not assume meals provided)"],
  ["13:00–16:00", "Hacking · optional NASA-data clinic ~14:00"],
  ["16:00–17:00", "Day-1 wrap · optional evening work off-site for duty-free adults"],
];

const day2 = [
  ["12:00", "Doors · check-in · hacking resumes"],
  ["12:30–15:00", "Hacking · demo/submit clinic ~13:00"],
  ["15:00–16:30", "Optional local pitches (not required for Global)"],
  ["16:30–17:00", "Submit-together block — Project tab → public demo → Submit for Judging"],
  ["Until 23:59", "Final Submit for Judging on the Space Apps portal"],
];

function Agenda({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <section className="rounded-xl border border-border bg-surface/70 p-6">
      <h2 className="text-xl font-bold text-foreground">{title}</h2>
      <ol className="mt-4 space-y-3">
        {rows.map(([when, what]) => (
          <li key={when + what} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
            <span className="font-mono text-sm text-neon">{when}</span>
            <span className="text-sm text-muted">{what}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function SchedulePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Family-hours schedule</h1>
      <p className="mt-3 max-w-2xl text-muted">
        In-room hours, not a 48-hour lock-in. SUBASE Groton, building TBD.
        For people already on base or already allowed on. Not a public
        walk-up. Virtual is for that same circle if they cannot make the room.
      </p>
      <div className="mt-8 grid gap-6">
        <Agenda title="Saturday Nov 14 · 09:00–17:00" rows={day1} />
        <Agenda title="Sunday Nov 15 · 12:00–17:00" rows={day2} />
      </div>
    </div>
  );
}
