import { CHANGELOG, type ChangeTag } from "./changelog";

const TAG_LABEL: Record<ChangeTag, string> = {
  new: "new",
  improve: "improved",
  fix: "fixed",
};

// UpdatesTab lists every release newest-first as an inked card: version + date
// header, an optional tag sticker, then the plain-language changes.
export function UpdatesTab() {
  return (
    <div className="flex flex-col gap-4">
      {CHANGELOG.map((r) => (
        <article
          key={r.version}
          className="card-arcade flex flex-col gap-2 p-4 text-left"
        >
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-display text-lg font-black text-foreground">
              {r.title}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
              v{r.version} · {r.date}
            </span>
            {r.tag && (
              <span
                className="sticker ml-auto w-fit px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-foreground"
                style={{ "--rot": "-3deg" } as React.CSSProperties}
              >
                {TAG_LABEL[r.tag]}
              </span>
            )}
          </header>
          <ul className="flex list-disc flex-col gap-1 pl-5 font-hand text-lg leading-snug text-muted">
            {r.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}
