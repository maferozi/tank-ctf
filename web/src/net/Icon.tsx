// Small line icons for chips and buttons, drawn here so the game ships no icon assets.
// They take the text colour (currentColor) and the font size (1em square).
const PATHS = {
  soundOn: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  soundOff: "M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6",
  expand: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  shrink: "M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5",
  leave: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10",
  back: "M15 5l-7 7 7 7",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6",
  share: "M12 15V3M7 8l5-5 5 5M5 13v7h14v-7",
  play: "M8 5v14l11-7z",
  target: "M12 3v4M12 17v4M3 12h4M17 12h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21",
  micOff: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16",
  headphones: "M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1zM20 15h-3v5h2a1 1 0 0 0 1-1z",
  close: "M6 6l12 12M18 6L6 18",
  rotate: "M7 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 18h2",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill={name === "play" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
