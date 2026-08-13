const collaborators = [
  { name: "USO", note: "Local Collaborator" },
  { name: "MWR", note: "Local Collaborator" },
];

export function SponsorStrip() {
  return (
    <section aria-labelledby="sponsor-strip-heading" className="mt-14">
      <h2
        id="sponsor-strip-heading"
        className="text-sm font-semibold uppercase tracking-[0.18em] text-muted"
      >
        Local Collaborators
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {collaborators.map((s) => (
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
