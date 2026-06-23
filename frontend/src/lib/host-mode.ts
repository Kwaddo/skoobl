// Host mode: "screen" ⇒ the host is the shared big screen (doesn't play);
// "play" ⇒ the host joins the game as a player too.
export type HostMode = "screen" | "play";

export type HostModeOption = { value: HostMode; label: string };

// The big-screen display assumes a real shared screen (tablet/desktop). On a
// phone (isMobile) there's no shared screen to be, so only Play-along is offered;
// tablets and up get both modes.
export function hostModeOptions(isMobile: boolean): HostModeOption[] {
  if (isMobile) return [{ value: "play", label: "Play along" }];
  return [
    { value: "screen", label: "Big screen" },
    { value: "play", label: "Play along" },
  ];
}
