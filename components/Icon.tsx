const P: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  chevron: "M6 9l6 6 6-6",
  back: "M19 12H5M11 6l-6 6 6 6",
  refresh: "M4 12a8 8 0 0113.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 01-13.7 5.6L4 15.5M4 20v-4.5h4.5",
  download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14",
  share: "M12 15V4M8 7.5L12 4l4 3.5M5 13v6h14v-6",
  trash: "M4 7h16M9 7V4.5h6V7M6.5 7l.8 12a2 2 0 002 1.9h5.4a2 2 0 002-1.9l.8-12M10 11v6M14 11v6",
  folder: "M3 7.5A2 2 0 015 5.5h4l2 2h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  list: "M4 6.5h16M4 12h10M4 17.5h13",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  type: "M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6",
  // Same frame as "film" (the two studios side by side): a photo, a sun and a hill.
  image: "M4 5h16v14H4zM4 16l4.5-4.5 4 4 3-3L20 17M10.5 9.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z",
  lock: "M7 10V7a5 5 0 0110 0v3M5 10h14v10H5zM12 14v3",
  unlock: "M7 10V7a5 5 0 019.4-2.4M5 10h14v10H5zM12 14v3",
  undo: "M8 7L3 12l5 5M3 12h9a6 6 0 016 6",
  redo: "M16 7l5 5-5 5M21 12h-9a6 6 0 00-6 6",
  search: "M11 4a7 7 0 105.2 11.9L21 21M11 4a7 7 0 00-7 7",
  copy: "M8 8h11v11H8zM5 16H4V4h12v1",
  arrowLeft: "M20 12H4M10 6l-6 6 6 6",
  arrowRight: "M4 12h16M14 6l6 6-6 6",
  music: "M9 17.5V5.5l10-2v12M9 17.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 15.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  play: "M8 5.5l11 6.5-11 6.5z",
  pause: "M8.5 5v14M15.5 5v14",
};

export default function Icon({ name, size = 16 }: { name: keyof typeof P | "more"; size?: number }) {
  if (name === "more") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}
