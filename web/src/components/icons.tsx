/**
 * Icons, authored rather than borrowed from the character set.
 *
 * One geometry throughout: a 16-unit box, 1.5-unit stroke, square caps and square
 * joins. Square terminals are the point — a rounded stroke reads as friendly
 * signage and this is a set of instrument marks.
 *
 * The previous build used `✕` for close and `+` / `−` for disclosure. A text glyph
 * inherits the face's own weight and metrics, so it cannot hold a stroke weight
 * against a drawn set, and it lands in the accessibility tree as a character.
 */

const BOX = { viewBox: '0 0 16 16', xmlns: 'http://www.w3.org/2000/svg' } as const;

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'square',
  strokeLinejoin: 'miter',
} as const;

interface IconProps {
  className?: string;
  size?: number;
}

function svgProps({ className = '', size = 16 }: IconProps) {
  return { ...BOX, width: size, height: size, className, 'aria-hidden': true, focusable: false } as const;
}

// ---------------------------------------------------------------------------
// Interface icons
// ---------------------------------------------------------------------------

export function IconClose(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

/** Disclosure. Rotates rather than swapping to a second glyph. */
export function IconDisclose({ open = false, ...props }: IconProps & { open?: boolean }) {
  return (
    <svg {...svgProps(props)} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 160ms' }}>
      <path {...STROKE} d="M6 3l6 5-6 5" />
    </svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M6.5 3.5H12.5V9.5" />
      <path {...STROKE} d="M12.5 3.5L7 9" />
      <path {...STROKE} d="M11 12.5H3.5V5" />
    </svg>
  );
}

/** Export: a sheet leaving downward through the baseline it was written on. */
export function IconExport(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M8 2.5v7" />
      <path {...STROKE} d="M4.5 6.5L8 10l3.5-3.5" />
      <path {...STROKE} d="M2.5 12.5h11" />
    </svg>
  );
}

export function IconRetry(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path {...STROKE} d="M13 2.5v3h-3" />
    </svg>
  );
}

export function IconRun(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path fill="currentColor" d="M4.5 2.5l9 5.5-9 5.5z" />
    </svg>
  );
}

export function IconStop(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="4" y="4" width="8" height="8" fill="currentColor" />
    </svg>
  );
}

export function IconDeploy(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M8 13V3.5" />
      <path {...STROKE} d="M4.5 7L8 3.5 11.5 7" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Channel terminus marks
// ---------------------------------------------------------------------------

/**
 * The six verdicts differ by mark, by trace style and by written label, so no two
 * are separated by colour alone. These are the marks.
 */

/** Pass. A plain crossing tick — the channel simply continues. */
export function MarkPass(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M3 8h10" />
    </svg>
  );
}

/**
 * Done, in the run-shaped views.
 *
 * A tick rather than the crossing line above, and the two are not interchangeable.
 * MarkPass belongs to the step channel, where a drawn line runs through every step
 * and "passed" means the line simply continues — a tick there would be a foreign
 * object crossing the trace. In a column of stage headers there is no channel, and
 * a bare dash reads as "nothing here" rather than as "this completed".
 */
export function MarkDone(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M3 8.5l3.5 3.5L13 4.5" />
    </svg>
  );
}

/** Passed on a fallback. A hollow ring: reached, but not by the recorded route. */
export function MarkFallback(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle {...STROKE} cx="8" cy="8" r="4" />
    </svg>
  );
}

/** Repaired. The channel breaks and is spliced: two offset bars bridged. */
export function MarkRepaired(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M2.5 6h5" />
      <path {...STROKE} d="M8.5 10h5" />
      <path {...STROKE} d="M7.5 6l1 4" />
    </svg>
  );
}

/** Failed. A barred terminus: the channel is stopped, not continued. */
export function MarkFailed(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M4 4l8 8M12 4l-8 8" />
      <path {...STROKE} d="M2 14h12" />
    </svg>
  );
}

/** Needs review. A flag on a mast — held for a person. */
export function MarkReview(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M4.5 2.5v11" />
      <path fill="currentColor" d="M5.5 3h7l-2 2.5 2 2.5h-7z" />
    </svg>
  );
}

/** Not reached. A gap in the channel. */
export function MarkSkipped(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path {...STROKE} d="M3 8h2.5M10.5 8H13" />
    </svg>
  );
}

/** Undetermined — a classification still in flight. */
export function MarkPending(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle {...STROKE} cx="8" cy="8" r="1.25" />
    </svg>
  );
}
