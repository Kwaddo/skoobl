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
    <div className="ink-block flex shrink-0 flex-col items-start gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          Room code
        </span>
        <button
          type="button"
          onClick={copy}
          className="group flex items-center gap-3 text-left"
        >
          <span className="font-display text-3xl font-black uppercase tracking-[0.18em] text-foreground">
            {code}
          </span>
          <span
            className="sticker px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors group-hover:text-foreground"
            style={{ "--rot": "2deg" } as React.CSSProperties}
          >
            {copied ? "copied!" : "copy link"}
          </span>
        </button>
        <span className="mt-1 font-hand text-xl text-muted">
          scan to join →
        </span>
      </div>
      {/* Fixed dark-on-light tile so the code scans reliably in either theme;
          taped to the card like a print-out. */}
      <div className="tape shrink-0 self-center rotate-2 rounded-lg border-2 border-[#1b1813] bg-white p-2 sm:self-auto">
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
