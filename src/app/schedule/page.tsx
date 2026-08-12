import type { Metadata } from "next";

export const metadata: Metadata = { title: "Schedule" };

const day1 = [
  ["08:00–09:00", "Organizers arrive · tech check (event cannot start before 9:00 AM local)"],
  ["09:00", "Welcome · schedule · logistics"],
  ["~09:30", "Mentor / teammate briefing"],
  ["Morning", "Hacking begins"],
  ["Midday", "Lunch break"],
  ["Afternoon–evening", "Hacking continues · optional progress check-ins"],
  ["Evening", "Dinner break · optional day-1 debrief"],
];

const day2 = [
  ["Morning", "Group check-in · hacking resumes"],
  ["Midday", "Lunch break"],
  ["16:00–19:30", "Optional: local judging / pitches / awards (not required)"],
  ["Until 23:59", "Final project submit on Space Apps portal"],
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
      <h1 className="text-3xl font-bold tracking-tight">Sample schedule</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Sample agenda from Local Lead training. Final Groton times TBD. Local
        judging and pitch sessions are optional.
      </p>
      <div className="mt-8 grid gap-6">
        <Agenda title="Day 1 — Saturday Nov 14" rows={day1} />
        <Agenda title="Day 2 — Sunday Nov 15" rows={day2} />
      </div>
    </div>
  );
}
