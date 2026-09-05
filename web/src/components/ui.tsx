import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The atom layer.
 *
 * Square-cornered plates separated by hairline rules, no shadows anywhere. Depth
 * on this surface comes from rules and fill values, both of which are measurable;
 * a soft-shadowed rounded rectangle is the thing that stands in for content when
 * there is none, and this surface has plenty.
 */

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * One focus treatment, everywhere, and it is the accent.
 *
 * `focus-visible` rather than `focus` so a mouse press does not leave a ring
 * behind, but every keyboard arrival is unmistakable. The offset keeps the ring
 * clear of the element's own border so it reads on both plate values.
 */
/**
 * `outline-solid` is not decoration here, it is the whole ring.
 *
 * Tailwind v4's `outline-none` sets `--tw-outline-style: none`, and
 * `outline-2` compiles to `outline-style: var(--tw-outline-style)`. So the
 * focus-visible rule applied a 2px signal-coloured outline whose *style* still
 * resolved to `none`, and nothing painted: `:focus-visible` matched, the width
 * and colour were right, and every control on every screen was measurably
 * unfocusable to the eye. Naming the style under the same variant restores it.
 */
export const focusRing =
  'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2';

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

/**
 * Reveals an element once, on first entry, and then stops watching.
 *
 * Content is visible in the default state and the observer only controls a six
 * pixel offset. The previous build started at `opacity: 0`, so when the observer
 * did not fire 12 of 16 sections stayed invisible and every full-page capture
 * showed an empty document. The worst outcome here is content sitting slightly
 * low.
 */
export function useReveal<T extends HTMLElement>(): { ref: React.RefObject<T | null>; shown: boolean } {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, shown };
}

export function Reveal({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`transition-transform duration-300 ease-out ${shown ? 'translate-y-0' : 'translate-y-1.5'} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plates
// ---------------------------------------------------------------------------

export function Panel({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return (
    <Tag className={`rounded-plate border border-rule bg-plate-100 ${className}`}>{children}</Tag>
  );
}

/**
 * A plate's bezel: the cut label, an optional sentence under it, and instruments
 * on the right. Rule-separated from the plate body rather than tinted, so nested
 * plates never appear.
 */
export function PanelHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2 border-b border-rule px-4 py-3">
      <div className="min-w-0">
        {/* A real size step above body, not a fourth grey. 15px against 12px body
            is a 1.25 ratio, which is the smallest step that reads as a level rather
            than as a slightly different label — and it takes this heading out of the
            uppercase register, where a title is prose and not a field name. */}
        <h2 className="readout text-[17px] font-semibold leading-tight text-read-100">{title}</h2>
        {subtitle ? <p className="measure mt-1.5 text-[13px] leading-relaxed text-read-300">{subtitle}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </header>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3 border-b border-rule pb-1.5">
      {/* 13px, matching body rather than sitting under it: a subheading smaller
          than the prose it introduces inverts the hierarchy it is meant to create.
          Its subordination comes from case and tracking. */}
      <h3 className="label-cut text-[13px]">{children}</h3>
      {hint ? <span className="text-[12px] text-read-300">{hint}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * A locator, rendered as selectable text and never drawn onto an image. Monospace
 * here is for its actual purpose — this is a selector, and `l` against `1` and `0`
 * against `O` have to be distinguishable in it.
 */
export function Code({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={`select-all rounded-plate border border-rule bg-plate-000 px-1.5 py-0.5 align-middle font-mono text-[12px] leading-tight text-read-200 ${className}`}
    >
      {children}
    </code>
  );
}

export function Quote({ children, cite }: { children: ReactNode; cite?: string }) {
  return (
    <blockquote className="measure border-l border-signal pl-3 text-[13px] leading-relaxed text-read-200">
      {children}
      {cite ? <footer className="label-cut mt-1.5">{cite}</footer> : null}
    </blockquote>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

type ButtonTone = 'primary' | 'default' | 'danger' | 'ghost';

/**
 * Tones.
 *
 * `primary` is a solid fill in the signal colour with plate-dark text — 9.44:1,
 * and read unambiguously as a control. The previous build shipped the action that
 * starts a run as a 15%-opacity tint on a dark ground, which every reviewer read
 * as disabled. A control that has to be explained is not a control.
 *
 * `disabled` reduces to a rule-bounded plate with dimmed text, which is a
 * different shape from every enabled tone rather than the same shape faded.
 */
const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: 'bg-signal text-plate-000 font-semibold hover:bg-signal-ink',
  default: 'bg-plate-200 text-read-100 border border-rule-strong hover:bg-plate-200/70 hover:border-signal',
  danger: 'bg-plate-200 text-alarm-ink border border-alarm/60 hover:border-alarm',
  ghost: 'text-read-200 border border-transparent hover:border-rule hover:text-read-100',
};

export function Button({
  children,
  onClick,
  tone = 'default',
  disabled,
  title,
  type = 'button',
  className = '',
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`label-cut inline-flex items-center justify-center gap-2 rounded-plate px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:border disabled:border-rule disabled:bg-plate-100 disabled:text-read-300 ${
        disabled ? '' : BUTTON_TONES[tone]
      } ${focusRing} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * A two-position switch, labelled on both the control and the state.
 *
 * The state is written out — ARMED / OFF — rather than carried by the knob's
 * position alone, because position is the one cue a screen reader does not get and
 * a colour-blind reader may not resolve.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 ${disabled ? 'opacity-60' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 flex h-6 w-[3.25rem] shrink-0 items-center rounded-plate border px-0.5 transition-colors ${
          checked ? 'border-signal bg-signal/25' : 'border-rule bg-plate-000'
        } ${focusRing}`}
      >
        <span
          className={`block h-4 w-4 rounded-[1px] transition-transform ${
            checked ? 'translate-x-[1.9rem] bg-signal' : 'translate-x-0 bg-rule-strong'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium text-read-100">{label}</span>
          <span className={`label-cut ${checked ? 'text-signal' : ''}`}>{checked ? 'Armed' : 'Off'}</span>
        </span>
        {hint ? <span className="measure mt-1 block text-[12px] leading-relaxed text-read-300">{hint}</span> : null}
      </span>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label-cut mb-1.5 block">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-[12px] leading-relaxed text-alarm-ink">{error}</span>
      ) : hint ? (
        <span className="measure mt-1.5 block text-[12px] leading-relaxed text-read-300">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-plate border border-rule bg-plate-000 px-2.5 py-2 text-[13px] text-read-100 transition-colors placeholder:text-read-300 hover:border-rule-strong focus-visible:border-signal focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2 outline-none';

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** A working indicator drawn as a rule sweeping, not a spinning ring. */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Working"
      className={`inline-block h-3 w-3 shrink-0 animate-spin border border-rule border-t-signal ${className}`}
    />
  );
}

export function Empty({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="px-4 py-10">
      <p className="readout text-[15px] text-read-100">{title}</p>
      {body ? <p className="measure mt-2 text-[13px] leading-relaxed text-read-300">{body}</p> : null}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="measure rounded-plate border border-alarm/50 bg-plate-000 px-3 py-2 text-[13px] leading-relaxed text-alarm-ink">
      <span className="label-cut mr-2 text-alarm-ink">Fault</span>
      {children}
    </p>
  );
}

/**
 * A value that is not absent but not yet known.
 *
 * Distinct from zero on purpose: the appearance verdicts are computed at the end
 * of a run, and rendering them as 0 in the meantime states a result the run has
 * not reached.
 */
export function Pending({ label = 'Awaiting' }: { label?: string }) {
  return (
    <span className="label-cut inline-flex items-center gap-1.5">
      <span className="channel-live inline-block h-2 w-px bg-signal" aria-hidden />
      {label}
    </span>
  );
}
