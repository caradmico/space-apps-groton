import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border bg-surface/80">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
            Groton Local Event
          </p>
          <p className="mt-2 text-sm text-muted">
            NASA Space Apps Challenge · November 14–15, 2026 · Venue TBD
            (on-base Groton)
          </p>
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">Quick links</p>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            <li>
              <Link className="hover:text-neon" href="/schedule">
                Schedule
              </Link>
            </li>
            <li>
              <Link className="hover:text-neon" href="/volunteers">
                Volunteer
              </Link>
            </li>
            <li>
              <Link className="hover:text-neon" href="/sponsors">
                Sponsor
              </Link>
            </li>
            <li>
              <Link className="hover:text-neon" href="/resources">
                Resources
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">Official</p>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            <li>
              <a
                className="hover:text-neon"
                href="https://www.spaceappschallenge.org/2026/local-events/groton"
                target="_blank"
                rel="noopener noreferrer"
              >
                Groton local event page
              </a>
            </li>
            <li>
              <a
                className="hover:text-neon"
                href="https://www.spaceappschallenge.org/"
                target="_blank"
                rel="noopener noreferrer"
              >
                spaceappschallenge.org
              </a>
            </li>
          </ul>
          <p className="mt-4 text-xs text-muted">
            Ops owned by Space Boi · Local Lead: Cara
          </p>
        </div>
      </div>
    </footer>
  );
}
