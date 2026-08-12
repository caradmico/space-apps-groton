const sponsors = [
  { name: "USO", note: "Placeholder — partnership TBD" },
  { name: "MWR", note: "Placeholder — partnership TBD" },
];

export function SponsorStrip() {
  return (
    <section aria-labelledby="sponsor-strip-heading" className="mt-14">
      <div className="flex items-end justify-between gap-4">
        <h2
          id="sponsor-strip-heading"
          className="text-sm font-semibold uppercase tracking-[0.18em] text-muted"
        >
          Community partners
        </h2>
        <a
          href="/sponsors"
          className="text-sm font-medium text-neon hover:text-neon-dim"
        >
          Become a sponsor →
        </a>
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {sponsors.map((s) => (
          <li
            key={s.name}
            className="rounded-xl border border-dashed border-border bg-surface/60 px-5 py-6"
          >
            <p className="text-lg font-bold tracking-wide text-blue-bright">
              {s.name}
            </p>
            <p className="mt-1 text-sm text-muted">{s.note}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
