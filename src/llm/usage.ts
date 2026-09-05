/**
 * What the models actually cost, in tokens.
 *
 * Requests are easy to count and nearly useless: a locator resolution carries a
 * page's element inventory and a plan repair carries the whole prompt again, so two
 * calls can differ by an order of magnitude. Every free-tier ceiling that matters
 * here is denominated in tokens — 8,000 per request, 8,000 per minute, 200,000 per
 * day — so tokens are the unit to report and the unit to budget against.
 *
 * A process-wide counter rather than a value threaded through every call site.
 * The alternative is passing a meter into locator resolution, heal proposal and plan
 * generation, none of which have any business knowing about accounting. The
 * orchestrator reads the counter before and after a mission and records the
 * difference, which is correct because the queue serialises browser work: no two
 * missions resolve locators at the same time.
 */

export interface TokenUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const total: TokenUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Called by a provider client once per successful response. */
export function recordUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): void {
  total.calls += 1;
  total.promptTokens += usage.prompt_tokens ?? 0;
  total.completionTokens += usage.completion_tokens ?? 0;
  total.totalTokens +=
    usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

export function snapshot(): TokenUsage {
  return { ...total };
}

/** Usage between two snapshots — what one mission spent. */
export function since(before: TokenUsage): TokenUsage {
  return {
    calls: total.calls - before.calls,
    promptTokens: total.promptTokens - before.promptTokens,
    completionTokens: total.completionTokens - before.completionTokens,
    totalTokens: total.totalTokens - before.totalTokens,
  };
}
