import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sponsors" };

const targets = [
  {
    name: "USO",
    pitch: "TODO draft: Support service members and families hacking for Earth & space — snacks, lounge, or prize package. Placeholder until warm intro.",
  },
  {
    name: "MWR",
    pitch: "TODO draft: On-base quality-of-life partner for venue support, recreation tie-in, or prize lane. Placeholder until warm intro.",
  },
];

export default function SponsorsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Sponsors</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Key targets for Groton: USO and MWR. Drafts only — Local Lead sends.
      </p>
      <ul className="mt-8 grid gap-4 md:grid-cols-2">
        {targets.map((t) => (
          <li key={t.name} className="rounded-xl border border-border bg-surface/70 p-6">
            <h2 className="text-xl font-bold text-blue-bright">{t.name}</h2>
            <p className="mt-3 text-sm text-muted">{t.pitch}</p>
          </li>
        ))}
      </ul>
      <div className="mt-10 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-bold">Become a sponsor</h2>
        <p className="mt-2 text-sm text-muted">Prizes, food, swag, or venue support.</p>
        <a
          href="mailto:caradmico@gmail.com?subject=Space%20Apps%20Groton%20sponsor"
          className="mt-4 inline-flex rounded-full bg-neon px-5 py-2.5 text-sm font-bold text-background hover:bg-neon-dim"
        >
          Talk to Local Lead
        </a>
      </div>
    </div>
  );
}
