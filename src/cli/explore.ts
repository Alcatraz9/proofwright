import { launchBrowser, newPage } from '../browser/session.js';
import { crawl } from '../explore/crawl.js';
import { formCount } from '../explore/types.js';
import { parseArgs } from '../util/args.js';

/**
 * Crawls a URL and prints what it found.
 *
 * Exists because the crawl makes no model calls, so it is the one part of the
 * pipeline that can be exercised repeatedly against a real target without touching
 * the daily quota — which makes it the right tool for pointing at whatever
 * application the organisers hand over and seeing immediately whether the map is
 * worth planning from.
 *
 *   npm run explore -- --url https://example.com --pages 8 --depth 2
 */
async function main(): Promise<void> {
  const { options } = parseArgs();
  const url = options.get('url') ?? 'http://127.0.0.1:7860/app/';
  const pageLimit = Number(options.get('pages') ?? 8);
  const depthLimit = Number(options.get('depth') ?? 2);

  console.log(`Exploring ${url} (max ${pageLimit} pages, depth ${depthLimit})\n`);

  const browser = await launchBrowser({ headed: false });
  try {
    const page = await newPage(browser);
    const map = await crawl(page, {
      entryUrl: url,
      pageLimit,
      depthLimit,
      onPage: (state) => {
        console.log(`  [d${state.depth}] ${state.url}`);
        console.log(
          `        ${state.elementCount} elements, ${state.forms.length} form(s), ${state.links.length} link(s)`,
        );
        for (const form of state.forms) {
          const kind = form.isAuth ? 'auth form' : 'form';
          console.log(
            `        ${kind} #${form.index}: ${form.fields.map((f) => f.label).join(', ')}`,
          );
          for (const negative of form.negativeOpportunities) {
            console.log(`          - ${negative.kind}: ${negative.field}`);
          }
        }
        if (state.destructiveActions.length) {
          console.log(`        destructive (not operated): ${state.destructiveActions.join(', ')}`);
        }
      },
    });

    console.log('\n--- site map ---');
    console.log(`pages          ${map.pages.length}`);
    console.log(`forms          ${formCount(map)}`);
    console.log(
      `negatives      ${map.pages.reduce(
        (total, page) =>
          total + page.forms.reduce((sum, form) => sum + form.negativeOpportunities.length, 0),
        0,
      )}`,
    );
    console.log(`auth           wall=${map.auth.wallFound} through=${map.auth.authenticated}`);
    console.log(`               ${map.auth.note}`);
    console.log(
      `budget         ${map.budget.pagesVisited}/${map.budget.pageLimit} pages, ${Math.round(
        map.budget.elapsedMs / 1000,
      )}s, exhausted=${map.budget.exhausted}`,
    );
    if (map.unvisited.length) {
      console.log(`unvisited      ${map.unvisited.length}`);
      for (const entry of map.unvisited.slice(0, 6)) {
        console.log(`               ${entry.url} — ${entry.reason}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
