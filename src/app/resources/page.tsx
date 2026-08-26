import type { Metadata } from "next";

export const metadata: Metadata = { title: "Resources" };

const links = [
  { label: "Star Visualizer (StarIS)", href: "https://staris-b01f2.firebaseapp.com/", note: "Explore nearby stars — free demo linked from Groton (Path A, no billing)" },
  { label: "Official Groton local event page", href: "https://www.spaceappschallenge.org/2026/local-events/groton", note: "Register is open." },
  { label: "NASA Space Apps Challenge", href: "https://www.spaceappschallenge.org/", note: "Global program home" },
  { label: "Challenge summaries", href: "https://www.spaceappschallenge.org/", note: "Coming September 17, 2026" },
  { label: "Full challenge statements", href: "https://www.spaceappschallenge.org/", note: "Coming October 28, 2026" },
  { label: "Ops board (internal)", href: "https://github.com/caradmico/jarvis-operator/blob/main/ops/plans/06-space-apps.md", note: "Space Boi flagship plan" },
];

export default function ResourcesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Resources</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Official links and timing. Use 2026 NASA Space Apps Challenge logos only — no NASA meatball/worm.
      </p>
      <ul className="mt-8 space-y-3">
        {links.map((l) => (
          <li key={l.label} className="rounded-xl border border-border bg-surface/70 px-5 py-4">
            <a href={l.href} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-bright hover:text-neon">
              {l.label}
            </a>
            <p className="mt-1 text-sm text-muted">{l.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
