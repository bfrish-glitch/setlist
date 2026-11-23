/** Transport icons drawn in the button's own color, so iOS never swaps in emoji. */
type P = { size?: number };
const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {children}
  </svg>
);

export const PlayIcon = ({ size = 22 }: P) => svg(size, <path d="M8 5.2c0-.8.9-1.3 1.6-.9l10 6.3c.6.4.6 1.4 0 1.8l-10 6.3c-.7.4-1.6-.1-1.6-.9V5.2Z" />);

export const PauseIcon = ({ size = 22 }: P) =>
  svg(
    size,
    <>
      <rect x="6" y="5" width="4.2" height="14" rx="1.4" />
      <rect x="13.8" y="5" width="4.2" height="14" rx="1.4" />
    </>,
  );

export const PrevIcon = ({ size = 22 }: P) =>
  svg(
    size,
    <>
      <rect x="4.5" y="5" width="2.6" height="14" rx="1.2" />
      <path d="M19.5 6.1c0-.8-.9-1.3-1.6-.8l-8.6 5.9c-.6.4-.6 1.3 0 1.7l8.6 5.9c.7.5 1.6 0 1.6-.8V6.1Z" />
    </>,
  );

export const NextIcon = ({ size = 22 }: P) =>
  svg(
    size,
    <>
      <rect x="16.9" y="5" width="2.6" height="14" rx="1.2" />
      <path d="M4.5 6.1c0-.8.9-1.3 1.6-.8l8.6 5.9c.6.4.6 1.3 0 1.7l-8.6 5.9c-.7.5-1.6 0-1.6-.8V6.1Z" />
    </>,
  );

export const LoadingIcon = ({ size = 22 }: P) => (
  <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);
