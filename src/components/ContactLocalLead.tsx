"use client";

import { type FormEvent, useId, useState } from "react";

const OFFICIAL_GROTON =
  "https://www.spaceappschallenge.org/2026/local-events/groton";

const fieldClass =
  "mt-1 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon";

const primaryClass =
  "inline-flex rounded-full bg-neon px-5 py-2.5 text-sm font-bold text-background hover:bg-neon-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon";

type Phase = "cta" | "form" | "done";

export function ContactLocalLead({ note }: { note?: string }) {
  const [phase, setPhase] = useState<Phase>("cta");
  const nameId = useId();
  const emailId = useId();
  const messageId = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPhase("done");
  }

  if (phase === "cta") {
    return (
      <button
        type="button"
        className={`mt-4 ${primaryClass}`}
        onClick={() => setPhase("form")}
      >
        Contact Local Lead
      </button>
    );
  }

  if (phase === "done") {
    return (
      <div className="mt-4 space-y-3" role="status">
        <p className="text-sm text-muted">
          This site does not send messages. Reach Local Lead on the official
          Groton event page.
        </p>
        <a
          href={OFFICIAL_GROTON}
          target="_blank"
          rel="noopener noreferrer"
          className={primaryClass}
        >
          Official Groton event page
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      <p className="text-xs text-muted">
        No personal inbox is listed here. After you continue, finish contact on
        the official Groton event page.
      </p>
      <div>
        <label htmlFor={nameId} className="block text-sm font-semibold">
          Name
        </label>
        <input
          id={nameId}
          name="name"
          type="text"
          required
          autoComplete="name"
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor={emailId} className="block text-sm font-semibold">
          Email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          required
          autoComplete="email"
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor={messageId} className="block text-sm font-semibold">
          Message
        </label>
        <textarea
          id={messageId}
          name="message"
          required
          rows={4}
          maxLength={2000}
          className={fieldClass}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={primaryClass}>
          Continue
        </button>
        <a
          href={OFFICIAL_GROTON}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-blue-bright hover:text-neon"
        >
          Official Groton event page
        </a>
      </div>
    </form>
  );
}
