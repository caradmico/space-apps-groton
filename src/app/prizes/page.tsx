import type { Metadata } from "next";

export const metadata: Metadata = { title: "Prizes" };

const tiers = [
  { name: "Local champion", note: "TODO: top local project recognition + prize TBD" },
  { name: "People's choice", note: "TODO: participant vote · prize TBD" },
  { name: "Category shout-outs", note: "TODO: e.g. best first-time team, best use of NASA data" },
  { name: "Participation", note: "Official Space Apps participant certificate via global platform" },
];

export default function PrizesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Prizes</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Placeholder tiers while we lock sponsors (USO · MWR) and prize partners.
        Global awards run through NASA Space Apps after local nomination.
      </p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {tiers.map((t) => (
          <li key={t.name} className="rounded-xl border border-dashed border-border bg-surface/60 p-6">
            <h2 className="text-lg font-bold text-blue-bright">{t.name}</h2>
            <p className="mt-2 text-sm text-muted">{t.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
