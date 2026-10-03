import Link from "next/link";

const official =
  "https://www.spaceappschallenge.org/2026/local-events/groton";

export default function HomePage() {
  return (
    <div className="starfield">
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-neon">
          Free virtual event · Groton
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          NASA Space Apps Challenge
        </h1>
        <div className="mt-4 max-w-2xl space-y-4 text-lg text-muted">
          <p>
            Groton’s first NASA Space Apps Challenge is a free virtual event.
            Join from anywhere.
          </p>
          <p>
            The hackathon is November 14–15, 2026. Teams of up to six use open
            NASA data to address a challenge. No coding experience is required.
          </p>
          <p>
            Challenge summaries are available now. Full challenge statements
            will be released October 28. Register on the official NASA Space
            Apps Challenge site and select Groton. Registration remains open
            through November 15.
          </p>
          <p>
            Hours are Saturday, 09:00–17:00 ET, and Sunday, 12:00–17:00 ET, all
            online. Participants under 18 may join only with a parent or
            guardian who registers and attends with them.
          </p>
          <p>
            If Groton is not the right fit, register for the Space Apps
            Universal Event.
          </p>
        </div>
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
            href="/schedule"
            className="inline-flex items-center justify-center rounded-full border border-border bg-surface px-6 py-3 text-sm font-semibold text-foreground hover:border-blue-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon"
          >
            Schedule
          </Link>
        </div>
        <dl className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            [
              "When",
              "Sat Nov 14 · 09:00–17:00 ET · Sun Nov 15 · 12:00–17:00 ET",
            ],
            ["Where", "Virtual · join from anywhere"],
            [
              "Challenges",
              "Summaries available now · full statements Oct 28",
            ],
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
      </section>
    </div>
  );
}
