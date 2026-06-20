import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { buildJoinUrl } from "@/lib/join-link";

// CodeCard shows the room code (with a copy button) plus a QR that drops a phone
// straight onto the prefilled Join form — share it from the lobby for both
// manual entry and instant scan-to-join.
export function CodeCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  // Absolute link the QR encodes. Same-origin, so the page's own origin is the
  // one players reach; the code rides in the query string.
  const joinUrl = buildJoinUrl(window.location.origin, code);
  // Copy the join link (not the bare code) so a tap-to-paste drops players
  // straight onto the prefilled Join form, same as scanning the QR.
  const copy = () => {
    navigator.clipboard?.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="card-arcade flex shrink-0 items-center justify-between gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          Room code
        </span>
        <button
          type="button"
          onClick={copy}
          className="group flex items-center gap-3 text-left"
        >
          <span className="font-mono text-3xl font-bold uppercase tracking-[0.2em] text-foreground">
            {code}
          </span>
          <span className="rounded-lg border border-border px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors group-hover:border-foreground group-hover:text-foreground">
            {copied ? "copied!" : "copy link"}
          </span>
        </button>
        <span className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted">
          scan to join →
        </span>
      </div>
      {/* Fixed dark-on-light tile so the code scans reliably in either theme. */}
      <div className="shrink-0 rounded-xl bg-white p-2">
        <QRCodeSVG
          value={joinUrl}
          size={104}
          level="M"
          marginSize={0}
          fgColor="#000000"
          bgColor="#ffffff"
          aria-label="QR code to join this room"
        />
      </div>
    </div>
  );
}
