import type { SVGProps } from 'react';

/** 작은 선 아이콘(16px 기준). 색은 currentColor를 따른다. */
const paths = {
  star: <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />,
  play: <path d="M5 3.2v9.6L12.5 8z" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  reset: <path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  left: <path d="m10 3.5-4.5 4.5 4.5 4.5" />,
  right: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  search: <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.6-1.4L14 14" />,
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, filled = false, ...rest }: Readonly<{ name: IconName; size?: number; filled?: boolean } & SVGProps<SVGSVGElement>>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={name === 'play' ? 1.2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
