import type { Metadata } from "next";
import { ContactLocalLead } from "@/components/ContactLocalLead";

export const metadata: Metadata = { title: "Volunteers" };

const roles = [
  { title: "Check-in (2–3 hr shift)", body: "Greet people, point to Wi‑Fi and rooms. No tech required." },
  { title: "Room floater", body: "Help teams find power/outlets; escalate venue issues." },
  { title: "Mentor (drop-in)", body: "Optional office hours for coding / design / pitch help." },
  { title: "Judge (Oct 31 milestone)", body: "Need ≥3 local judges. Short training + evaluate projects." },
  { title: "Comms buddy", body: "Post approved updates; photo help. Drafts only until Local Lead okays." },
];

export default function VolunteersPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Volunteer</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Low-lift roles — we know bandwidth is tight. Pick one shift or one specialty.
      </p>
      <ul className="mt-8 grid gap-4 md:grid-cols-2">
        {roles.map((r) => (
          <li key={r.title} className="rounded-xl border border-border bg-surface/70 p-6">
            <h2 className="text-lg font-bold text-foreground">{r.title}</h2>
            <p className="mt-2 text-sm text-muted">{r.body}</p>
          </li>
        ))}
      </ul>
      <div className="mt-10 rounded-xl border border-neon/40 bg-surface p-6">
        <h2 className="text-lg font-bold">Interested?</h2>
        <p className="mt-2 text-sm text-muted">
          Share your name, role interest, and availability.
        </p>
        <ContactLocalLead note="Include the role you want and when you can help." />
      </div>
    </div>
  );
}
