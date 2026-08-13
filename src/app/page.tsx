import Link from "next/link";
import { SponsorStrip } from "@/components/SponsorStrip";

const official =
  "https://www.spaceappschallenge.org/2026/local-events/groton";

export default function HomePage() {
  return (
    <div className="starfield">
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-neon">
          Local event · Groton / SUBASE New London
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          NASA Space Apps Challenge
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">
          November 14–15, 2026. On-base Groton, building TBD. For sailors,
          navy family, students already here, and navy-adjacent people with
          access (Electric Boat and similar). Not a public walk-up. Going
          off base is hard — so the hackathon comes to SUBASE. No coding
          required.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={official}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-full bg-neon px-6 py-3 text-sm font-bold text-background hover:bg-neon-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
          >
            Register on Space Apps (opens Aug 26)
          </a>
          <Link
            href="/schedule"
            className="inline-flex items-center justify-center rounded-full border border-border bg-surface px-6 py-3 text-sm font-semibold text-foreground hover:border-blue-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
          >
            Family-hours schedule
          </Link>
        </div>
        <dl className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            ["When", "Sat Nov 14 · 09:00–17:00 · Sun Nov 15 · 12:00–17:00"],
            ["Where", "SUBASE Groton · building TBD · already-allowed access"],
            ["Challenges", "Summaries Sep 17 · full statements Oct 28"],
          ].map(([k, v]) => (
            <div
              key={k}
              className="rounded-xl border border-border bg-surface/70 px-5 py-4"
            >
              <dt className="text-xs font-semibold uppercase tracking-wider text-neon">
                {k}
              </dt>
              <dd className="mt-1 text-sm text-muted">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-8 max-w-2xl rounded-xl border border-border bg-surface/70 px-5 py-4 text-sm text-muted">
          If you already belong on SUBASE, you belong in this room. Other
          interested people: case by case. If Groton isn&apos;t the fit, use
          the Space Apps Universal Event. Bring a laptop, charger, CAC or
          ID, water bottle. Under-18s need a parent or guardian registered
          and on-site. Local Collaborators: USO and MWR. Not NASA-funded.
        </div>
        <SponsorStrip />
      </section>
    </div>
  );
}
