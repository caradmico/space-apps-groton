import Link from "next/link";
import { SponsorStrip } from "@/components/SponsorStrip";

const official =
  "https://www.spaceappschallenge.org/2026/local-events/groton";

export default function HomePage() {
  return (
    <div className="starfield">
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-neon">
          Local event · Groton
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          NASA Space Apps Challenge
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">
          November 14–15, 2026 · Venue TBD (on-base Groton). A weekend
          hackathon using open NASA data to solve real Earth and space
          challenges — all ages and skill levels welcome.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={official}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-full bg-neon px-6 py-3 text-sm font-bold text-background hover:bg-neon-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
          >
            Register on Space Apps
          </a>
          <Link
            href="/volunteers"
            className="inline-flex items-center justify-center rounded-full border border-border bg-surface px-6 py-3 text-sm font-semibold text-foreground hover:border-blue-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
          >
            Volunteer (low-lift roles)
          </Link>
        </div>
        <dl className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            ["When", "Nov 14–15, 2026 · starts ≥ 9:00 AM local"],
            ["Where", "On-base Groton · exact venue TBD"],
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
        <SponsorStrip />
      </section>
    </div>
  );
}
