import { useCallback, useEffect, useRef } from 'react';

export interface Shortcut {
  /** A human-readable combo like "Ctrl+Enter" or "?" or "Escape". */
  combo: string;
  /** What it does — shown in the help overlay. */
  label: string;
  /** The handler. Return false to let the event propagate. */
  handler: () => void | false;
  /**
   * Which screens this shortcut is active on.
   * Omit or pass undefined for globally-active shortcuts (e.g. ?, Escape).
   * When present, the shortcut only fires if the current path matches.
   */
  activeOn?: string[];
}

/**
 * Ignores keystrokes originating inside editable elements so the shortcuts
 * never fight a text input. Only Escape is exempt so a stuck overlay is always
 * dismissable. `?` is NOT exempt — it must type normally in text inputs.
 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/** Normalise a KeyboardEvent into the same "Ctrl+Shift+K" string used in combo. */
function normalise(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  let key = event.key;
  if (key === ' ') key = 'Space';
  // Collapse Enter/Return to one token
  if (key === 'Enter') key = 'Enter';
  // Single printable characters are compared case-insensitively
  if (key.length === 1) key = key.toUpperCase();

  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
    parts.push(key);
  }
  return parts.join('+');
}

/**
 * Register global keyboard shortcuts. Stable across renders — the `shortcuts`
 * array is read from a ref so the caller does not need to memoise it.
 *
 * `currentPath` is passed so shortcuts with `activeOn` can be scoped per-screen.
 */
export function useHotkeys(shortcuts: Shortcut[], currentPath?: string): void {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;
  const pathRef = useRef(currentPath);
  pathRef.current = currentPath;

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const combo = normalise(event);

    for (const shortcut of ref.current) {
      if (shortcut.combo.toUpperCase() !== combo.toUpperCase()) continue;

      // Only Escape works inside editable elements (dismiss overlays).
      const exempt = shortcut.combo === 'Escape';
      if (!exempt && isEditable(event.target)) return;

      // Screen-scoped shortcut: skip if current path doesn't match.
      if (shortcut.activeOn && pathRef.current !== undefined) {
        const matches = shortcut.activeOn.some((p) => pathRef.current === p || pathRef.current?.startsWith(p + '/'));
        if (!matches) return;
      }

      event.preventDefault();
      shortcut.handler();
      return;
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);
}

// ---------------------------------------------------------------------------
// Two-key chord support for g+<letter> navigation
// ---------------------------------------------------------------------------

/**
 * A chord shortcut uses a two-key sequence: the first key arms the chord,
 * and the second key within a timeout window fires the handler.
 */
export interface ChordShortcut {
  /** Display combo, e.g. "g c" */
  combo: string;
  /** Description for help panel */
  label: string;
  /** Handler fires when the full chord completes */
  handler: () => void;
}

/**
 * Registers two-key chord shortcuts (g then c, g then r, etc).
 * The first key arms a 800ms window; the second key within that window fires.
 * Chords are suppressed inside editable elements.
 */
export function useChordShortcuts(chords: ChordShortcut[]): void {
  const chordsRef = useRef(chords);
  chordsRef.current = chords;
  const armedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (isEditable(event.target)) return;
    // Ignore if any modifier is held — chords are bare letters only.
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      armedRef.current = false;
      return;
    }

    const key = event.key.toLowerCase();

    if (!armedRef.current) {
      // First key: arm if it's 'g'
      if (key === 'g') {
        armedRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          armedRef.current = false;
        }, 800);
      }
      return;
    }

    // Second key: check chords
    armedRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    for (const chord of chordsRef.current) {
      // chord.combo is "g c" — extract the second letter
      const secondKey = chord.combo.split(' ')[1]?.toLowerCase();
      if (secondKey === key) {
        event.preventDefault();
        chord.handler();
        return;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onKeyDown]);
}

// ---------------------------------------------------------------------------
// Focus trap hook for modal dialogs
// ---------------------------------------------------------------------------

/**
 * Returns true when the element is a real focusable interactive element,
 * not <body> or <html> or null.
 */
function isFocusableElement(el: Element | null): el is HTMLElement {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (!(el instanceof HTMLElement)) return false;
  return el.tabIndex >= 0 || el.matches('a[href], button, input, select, textarea, [tabindex]');
}

/**
 * Traps focus inside a container element. On mount, moves focus into the
 * container. Tab / Shift+Tab cycle between focusable elements. On unmount,
 * restores focus to `returnFocusTo.current` if provided and focusable,
 * falling back to the previously-focused element only if it was a real
 * interactive element (not <body>).
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  returnFocusTo?: React.RefObject<HTMLElement | null>,
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Save the element that had focus before the trap opened.
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (!container) return;

    // Move focus into the container on open.
    const focusables = getFocusableElements(container);
    const firstOnOpen = focusables[0];
    if (firstOnOpen) {
      firstOnOpen.focus();
    } else {
      // If there are no focusable elements, focus the container itself.
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || !container) return;

      const currentFocusables = getFocusableElements(container);
      if (currentFocusables.length === 0) {
        event.preventDefault();
        return;
      }

      const first = currentFocusables[0];
      const last = currentFocusables[currentFocusables.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }

      if (event.shiftKey) {
        // Shift+Tab from first → wrap to last
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        // Tab from last → wrap to first
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);

      // Restore focus on unmount:
      // 1. Prefer the explicit returnFocusTo ref if provided and focusable
      // 2. Fall back to previously focused element only if it was a real
      //    interactive element (not <body>)
      const explicit = returnFocusTo?.current;
      if (explicit && isFocusableElement(explicit)) {
        explicit.focus();
      } else if (isFocusableElement(previouslyFocusedRef.current)) {
        previouslyFocusedRef.current.focus();
      }
      // Otherwise: don't focus anything — browser stays on <body> which is
      // correct for a keyboard user who had no prior focus context.
    };
  }, [containerRef, returnFocusTo]);
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}
