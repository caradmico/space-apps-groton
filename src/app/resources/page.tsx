import type { Metadata } from "next";

export const metadata: Metadata = { title: "Resources" };

const binLodHref = `${process.env.PAGES_BASE_PATH || ""}/bin-lod/`;

const links = [
  { label: "StarIS BIN LOD (Spark)", href: binLodHref, note: "Massive 62-byte .BIN catalog in the browser. Far view is generalized, near view is accurate." },
  { label: "Star Visualizer (StarIS)", href: "https://staris-b01f2.firebaseapp.com/", note: "Explore nearby stars. Free demo linked from Groton." },
  { label: "Official Groton local event page", href: "https://www.spaceappschallenge.org/2026/local-events/groton", note: "Register is open." },
  { label: "NASA Space Apps Challenge", href: "https://www.spaceappschallenge.org/", note: "Global program home" },
  { label: "Challenge summaries", href: "https://www.spaceappschallenge.org/", note: "Coming September 17, 2026" },
  { label: "Full challenge statements", href: "https://www.spaceappschallenge.org/", note: "Coming October 28, 2026" },
];

export default function ResourcesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Resources</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Official links and timing for the fully remote Groton weekend.
      </p>
      <ul className="mt-8 space-y-3">
        {links.map((l) => (
          <li key={l.label} className="rounded-xl border border-border bg-surface/70 px-5 py-4">
            {l.href ? (
              <a
                href={l.href}
                target={l.href.startsWith("http") ? "_blank" : undefined}
                rel={l.href.startsWith("http") ? "noopener noreferrer" : undefined}
                className="font-semibold text-blue-bright hover:text-neon"
              >
                {l.label}
              </a>
            ) : (
              <span className="font-semibold">{l.label}</span>
            )}
            <p className="mt-1 text-sm text-muted">{l.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
