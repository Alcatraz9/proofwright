import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator as PlaywrightLocator, Page } from 'playwright';
import { PATHS } from '../config.js';

/**
 * Screenshots for the one moment where a picture explains something words do not:
 * a heal.
 *
 * Deliberately narrow. There is no live view of the application in the dashboard
 * and no continuous capture — a mirrored viewport competes for attention with the
 * reasoning, and it is the first thing to fall over on a small host. Two still
 * images at the moment a locator is repaired carry the whole explanation: this is
 * the element the test was recorded against, and this is what was found instead.
 *
 * Both are cropped to the element with surrounding context rather than shown full
 * page. A full page with a small outline somewhere in it does not communicate; a
 * crop does.
 */

const PADDING = 48;
/**
 * Floor on the crop, so a small control still arrives with enough of its
 * surroundings to be recognisable. A 40px icon button cropped to 136px square is
 * technically the element and tells a reader nothing about where it sits.
 */
const MIN_CROP = 260;
const HIGHLIGHT_ATTRIBUTE = 'data-qa-highlight';

export interface ElementShot {
  /** Path relative to the artifacts root, for serving. */
  relPath: string;
  width: number;
  height: number;
}

/**
 * Draws a temporary outline around the element and removes it again.
 *
 * The overlay is a sibling element rather than a style on the target, because
 * changing the target's own computed style is exactly what the visual signature
 * measures — a border added here would be indistinguishable from the application
 * having gained one. It is removed before this function returns for the same
 * reason: an overlay still present when a signature is captured registers as new
 * content.
 *
 * An outline and nothing else. An earlier version drew the locator into the image
 * as a caption, which was clipped by the crop on any element narrower than its own
 * description — and text rendered into a PNG cannot be selected, searched or read
 * by a screen reader. The interface shows the locator as markup beside the image,
 * which is both legible and appropriate for a tool that audits accessibility.
 */
async function withHighlight<T>(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  action: () => Promise<T>,
): Promise<T> {
  await page.evaluate(
    ({ rect, attribute }) => {
      const outline = document.createElement('div');
      outline.setAttribute(attribute, 'outline');
      Object.assign(outline.style, {
        position: 'absolute',
        left: `${rect.x - 3}px`,
        top: `${rect.y - 3}px`,
        width: `${rect.width + 6}px`,
        height: `${rect.height + 6}px`,
        border: '2px solid #e11d48',
        borderRadius: '3px',
        boxShadow: '0 0 0 3px rgba(225, 29, 72, 0.22)',
        pointerEvents: 'none',
        zIndex: '2147483647',
      });

      document.body.append(outline);
    },
    { rect: box, attribute: HIGHLIGHT_ATTRIBUTE },
  );

  try {
    return await action();
  } finally {
    await page
      .evaluate((attribute) => {
        for (const node of document.querySelectorAll(`[${attribute}]`)) node.remove();
      }, HIGHLIGHT_ATTRIBUTE)
      .catch(() => {
        /* the page may have navigated; the overlay went with it */
      });
  }
}

/**
 * Captures the element with its surroundings, outlined and labelled.
 *
 * Returns null rather than throwing. A missing picture is a cosmetic loss; a
 * screenshot failure becoming a step's verdict would not be.
 */
export async function captureElementShot(params: {
  page: Page;
  locator: PlaywrightLocator;
  relPath: string;
}): Promise<ElementShot | null> {
  const { page, locator, relPath } = params;

  try {
    const box = await locator.boundingBox({ timeout: 2000 });
    if (!box) return null;

    // Document coordinates, since the clip region is document-relative while
    // boundingBox is viewport-relative.
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const documentBox = { ...box, x: box.x + scroll.x, y: box.y + scroll.y };

    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    // Grown to the floor around the element's centre, then clamped to the document,
    // so a small control keeps its surroundings without the crop drifting off-page.
    const desiredWidth = Math.max(MIN_CROP, documentBox.width + PADDING * 2);
    const desiredHeight = Math.max(MIN_CROP, documentBox.height + PADDING * 2);
    const centreX = documentBox.x + documentBox.width / 2;
    const centreY = documentBox.y + documentBox.height / 2;

    const width = Math.min(dimensions.width, desiredWidth);
    const height = Math.min(dimensions.height, desiredHeight);

    const clip = {
      x: Math.min(Math.max(0, centreX - width / 2), Math.max(0, dimensions.width - width)),
      y: Math.min(Math.max(0, centreY - height / 2), Math.max(0, dimensions.height - height)),
      width,
      height,
    };

    const absolute = path.join(PATHS.artifacts, relPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    await withHighlight(page, documentBox, async () => {
      await page.screenshot({ path: absolute, clip, fullPage: true, type: 'png' });
    });

    return { relPath, width: Math.round(clip.width), height: Math.round(clip.height) };
  } catch {
    return null;
  }
}

/**
 * Captures the whole page, with no element outlined.
 *
 * Used when the element the test wanted is not on the page at all, which is the
 * usual reason a heal was needed — there is no box to crop to, and the page as a
 * whole is the useful evidence.
 */
export async function capturePageShot(params: {
  page: Page;
  relPath: string;
}): Promise<ElementShot | null> {
  try {
    const absolute = path.join(PATHS.artifacts, params.relPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await params.page.screenshot({ path: absolute, fullPage: true, type: 'png' });

    const dimensions = await params.page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    return { relPath: params.relPath, width: dimensions.width, height: dimensions.height };
  } catch {
    return null;
  }
}

/** Where a step's recorded appearance lives. Keyed by plan, since it belongs to the baseline. */
export function baselineShotPath(planId: string, stepId: string): string {
  return path.posix.join('baselines', sanitiseSegment(planId), `${sanitiseSegment(stepId)}.png`);
}

/** Where a heal's evidence lives. Keyed by run, since it belongs to that attempt. */
export function healShotPath(runId: string, stepId: string, kind: 'found' | 'page'): string {
  return path.posix.join(
    'runs',
    sanitiseSegment(runId),
    `${sanitiseSegment(stepId)}-${kind}.png`,
  );
}

/**
 * Ids come from callers and end up in a filesystem path, so anything that could
 * climb out of the artifacts directory is stripped here rather than trusted.
 * The serving route validates independently — this is the first of two checks,
 * not the only one.
 */
function sanitiseSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
}
