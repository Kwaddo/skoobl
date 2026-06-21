// Panel is a host dashboard card that fills its column and scrolls its body when
// the content is taller than the space — the workhorse that keeps the big screen
// looking full and organized instead of leaving floating gaps.
export function Panel({
  title,
  aside,
  children,
  className = "",
}: {
  title?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`card-arcade flex min-h-0 flex-col p-4 sm:p-5 ${className}`}
    >
      {(title || aside) && (
        <div className="mb-3 flex shrink-0 items-baseline justify-between gap-3">
          {title && (
            <h2 className="ink-underline font-display text-lg font-black sm:text-xl">
              {title}
            </h2>
          )}
          {aside}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto pr-1">{children}</div>
    </div>
  );
}
