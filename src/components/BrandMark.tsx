import { useId, type SVGProps } from "react";

type BrandMarkProps = Omit<SVGProps<SVGSVGElement>, "title"> & {
  /** Accessible name for standalone marks. Omit it when the mark is decorative. */
  title?: string;
};

/**
 * The single WingRate mark used inside the app shell and install UI.
 * The geometry intentionally mirrors public/favicon.svg so the in-app mark,
 * browser tab, and installed PWA all use the same identity.
 */
export default function BrandMark({ title, ...props }: BrandMarkProps) {
  const id = useId().replace(/:/g, "");
  const surfaceId = `${id}-surface`;
  const glowId = `${id}-glow`;
  const titleId = `${id}-title`;

  return (
    <svg
      {...props}
      viewBox="0 0 512 512"
      role={title ? "img" : "presentation"}
      aria-labelledby={title ? titleId : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title id={titleId}>{title}</title> : null}
      <defs>
        <linearGradient id={surfaceId} x1="0.18" y1="0" x2="0.82" y2="1">
          <stop offset="0" stopColor="#818cf8" />
          <stop offset="0.48" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#0a0e1a" />
        </linearGradient>
        <radialGradient id={glowId} cx="0.78" cy="0.18" r="0.7">
          <stop offset="0" stopColor="#a5b4fc" stopOpacity="0.38" />
          <stop offset="1" stopColor="#a5b4fc" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="512" height="512" fill={`url(#${surfaceId})`} />
      <rect width="512" height="512" fill={`url(#${glowId})`} />
      <path
        d="M104 302 L180 378 L256 228 L332 354 L403 145"
        fill="none"
        stroke="#ffffff"
        strokeWidth="42"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M403 104 L435 167 L371 150 Z" fill="#22d3ee" />
      <circle cx="104" cy="302" r="20" fill="#22d3ee" />
    </svg>
  );
}
