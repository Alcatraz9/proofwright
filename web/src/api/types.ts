/**
 * The server contract, restated for the client.
 *
 * Deliberately hand-written rather than imported from `src/`. The two halves are
 * built by different toolchains against different module resolutions, and a
 * shared type would drag the server's zod schemas and node types into the
 * browser bundle. Writing the wire shape down once, here, also makes it the
 * single place to look when a payload changes.
 */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  /** Passed, but more repaired itself than we are willing to accept unattended. */
  | 'needs_review'
  | 'cancelled'
  | 'error';

export type PlanStatus = 'DRAFT' | 'APPROVED';

export type StepStatus = 'passed' | 'failed' | 'skipped';

export type FaultKind = 'serverError' | 'slow' | 'expireSession';

export type HealRejectionStatus =
  | 'rejected'
  | 'below_threshold'
  | 'no_candidate'
  | 'unlocatable'
  | 'execution_failed';

export type VisualChangeKind =
  | 'COSMETIC'
  | 'TEXT_CHANGED'
  | 'LAYOUT_SHIFT'
  | 'CONTENT_MISSING'
  | 'CONTENT_REPLACED'
  | 'CONTENT_ADDED';

export type VisualSeverity = 'info' | 'warn' | 'fail';
export type A11yImpact = 'critical' | 'serious' | 'moderate' | 'minor';
export type SecuritySeverity = 'high' | 'medium' | 'low' | 'info';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type RunEventType =
  | 'RUN_QUEUED'
  | 'RUN_STARTED'
  | 'STEP_STARTED'
  | 'STEP_PASSED'
  | 'STEP_FAILED'
  | 'STEP_SKIPPED'
  | 'DRIFT_DETECTED'
  | 'HEALING_STARTED'
  | 'HEAL_ACCEPTED'
  | 'HEAL_REJECTED'
  | 'HEAL_ERROR'
  | 'HEAL_ESCALATED'
  | 'VISUAL_CAPTURED'
  | 'VISUAL_CHECKED'
  | 'VISUAL_COSMETIC_HEALED'
  | 'VISUAL_LAYOUT_SHIFT'
  | 'A11Y_CHECKED'
  | 'A11Y_STEP_CHECKED'
  | 'SECURITY_CHECKED'
  | 'RUN_COMPLETE'
  | 'RUN_ERROR'
  | 'STREAM_END';

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  payload: unknown;
}

export interface RunQueuedPayload {
  position: number;
  ahead: number;
}

export interface RunStartedPayload {
  planId: string;
  startUrl: string;
  steps: number;
  healing: boolean;
  threshold: number | null;
  activeVersion: string | null;
  /** Non-null when the recorded origin was moved onto the running app. */
  rebasedFrom: string | null;
}

export interface StepStartedPayload {
  stepId: string;
  action: string;
  /** Zero-based, from the replay's `steps.entries()`. Displayed 1-based. */
  index: number;
  total: number;
}

export interface StepFailure {
  kind: string;
  /** The distinction the product is built on. */
  healable: boolean;
  message: string;
}

export interface StepSettledPayload {
  stepId: string;
  action: string;
  status: StepStatus;
  durationMs: number;
  /** `describeLocator` output, e.g. `role=button[name="Search products"]`. */
  locator: string | null;
  usedFallback: boolean;
  outcomeChecked: boolean;
  failure: StepFailure | null;
}

export interface DriftPayload {
  stepId: string;
  locator: string | null;
}

/** `HEAL_ACCEPTED` and `HEAL_REJECTED` carry the same shape. */
export interface HealPayload {
  stepId: string;
  status: string;
  confidence: number;
  threshold: number;
  /** The model's own words. Rendered verbatim. */
  reason: string;
  /** What the application confirmed afterwards. */
  verification: string | null;
  model: string;
  candidatesProposed: number;
  candidatesTried: number;
  previousLocator: string;
  newLocator: string | null;
  /** False when the step had no post-condition to check the candidate against. */
  verifiedAgainstOutcome: boolean;
  proposalFromCache: boolean;
  shots: { baseline: string | null; found: string | null };
}

export interface HealErrorPayload {
  stepId: string;
  message: string;
}

export interface HealEscalatedPayload {
  stepId: string;
  healedSoFar: number;
  cap: number;
  message: string;
}

export interface VisualCapturedPayload {
  pagePath: string;
  viewport: string;
  elementCount: number;
}

export interface VisualFinding {
  kind: VisualChangeKind;
  severity: VisualSeverity;
  key: string;
  summary: string;
  movedBy: number | null;
  resizedBy: number | null;
  changes: { property: string; from: string; to: string }[];
}

export interface VisualCheckedPayload {
  pagePath: string;
  viewport: string;
  /** Set when the page had no recorded appearance and was recorded instead. */
  firstSight?: boolean;
  message?: string;
  elementCount?: number;
  cosmetic?: number;
  layoutShift?: number;
  missing?: number;
  replaced?: number;
  added?: number;
  clean?: boolean;
  absorbed?: boolean;
  findings?: VisualFinding[];
}

export interface A11yViolation {
  id: string;
  impact: A11yImpact;
  help: string;
  helpUrl: string;
  tags: string[];
  nodeCount: number;
  samples: { target: string; failureSummary: string }[];
}

/**
 * Per-element accessibility, for the specific controls the test drives.
 *
 * This is a separate layer from the page audit and carries the argument the
 * product is built on: the same missing accessible name that stops a screen reader
 * announcing a control is what forces its locator down to matching raw text or
 * position. The server has always published this; the client used to drop it and
 * substitute rule-level approximations written by hand.
 */
export interface A11yStepFinding {
  check: 'accessibleName' | 'placeholderOnlyName' | 'focusable' | 'contrast' | 'role';
  severity: 'warn' | 'info';
  message: string;
  /** Why the finding matters to the test and not only to a user. */
  testabilityNote: string | null;
}

export interface A11yStepCheckedPayload {
  stepId: string;
  locator: string;
  findings: A11yStepFinding[];
}

export interface A11yCheckedPayload {
  pagePath: string;
  score: number;
  passes: number;
  byImpact: Record<A11yImpact, number>;
  violations: A11yViolation[];
}

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  title: string;
  detail: string;
  evidence: string | null;
  remediation: string;
}

export interface SecurityCheckedPayload {
  pagePath: string;
  score: number;
  bySeverity: Record<SecuritySeverity, number>;
  findings: SecurityFinding[];
}

export interface RunCompletePayload {
  status: RunStatus;
  verdict: string;
  stepsTotal: number;
  stepsPassed: number;
  healed: number;
  healAttempts: number;
  escalated: boolean;
  unverifiedHeals: string[];
  drifted: string[];
  a11y: { score: number; violations: number; pages: number };
  security: { score: number; findings: number; pages: number };
  visual: {
    pagesCompared: number;
    pagesRecorded: number;
    cosmeticAbsorbed: number;
    layoutShifts: number;
    missing: number;
    failed: number;
    strict: boolean;
  };
  runFailure: { kind: string; message: string } | null;
}

export interface RunErrorPayload {
  message: string;
  stepId?: string;
  /** Present and false for a non-fatal inspection failure. */
  fatal?: boolean;
  aborted?: boolean;
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export interface Health {
  ok: boolean;
  activeVersion: string;
  faults: Record<FaultKind, boolean>;
  queue: { active: string[]; pending: string[]; concurrency: number };
  concurrency: number;
}

export interface FixtureVersion {
  id: string;
  displayName: string;
  story: string;
  demonstrates: string[];
  accessibility: string;
  security: string;
  url: string;
}

export interface FixtureState {
  activeVersion: string;
  faults: Record<FaultKind, boolean>;
  versions: FixtureVersion[];
}

export interface PlanSummary {
  planId: string;
  name: string;
  description: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  targetUrl: string;
  stepCount: number;
  hasBaseline: boolean;
  lastRunStatus: RunStatus | null;
  lastRunAt: string | null;
}

export interface IntentTarget {
  description: string;
  context: string | null;
}

export interface IntentStep {
  id: string;
  intent: string;
  sourcePhrase: string;
  action: string;
  target: IntentTarget | null;
  value: string | null;
  valueRef: string | null;
  expectedValue: string | null;
  expectedOutcome: { description: string } | null;
}

export interface IntentPlan {
  name: string;
  description: string;
  steps: IntentStep[];
  startUrl: string;
  requiredValueRefs: string[];
}

export interface PlanRecord {
  planId: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  status: PlanStatus;
  model: string;
  source: { targetUrl: string; instruction: string };
  plan: IntentPlan;
}

export interface Locator {
  strategy: string;
  value: string | null;
  role: string | null;
  name: string | null;
  nth: number | null;
}

export interface BaselineStepView {
  stepId: string;
  intent: string;
  action: string;
  value: string | null;
  valueRef: string | null;
  pageUrl: string;
  locator: Locator | null;
  fallbackLocators: Locator[];
  expectedOutcome: {
    assertions: { type: string; value: string | null }[];
    intended: string | null;
  };
  resolution: { confidence: number; reason: string };
  healHistory: {
    healedAt: string;
    confidence: number;
    reason: string;
    model: string;
    previousLocator: Locator;
  }[];
}

export interface BaselineView {
  baselineId: string;
  createdAt: string;
  model: string;
  startUrl: string;
  steps: BaselineStepView[];
}

export interface RunSummary {
  runId: string;
  planId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  startUrl: string;
  activeVersion: string | null;
  healingEnabled: boolean;
  durationMs: number | null;
  stepsTotal: number;
  stepsPassed: number;
  healCount: number;
  visualFindings: number;
  a11yViolations: number;
  securityFindings: number;
  llmCalls: number;
}

export interface RunDetail {
  summary: RunSummary;
  result: unknown;
  events: RunEvent[];
  artifacts: { stepId: string | null; kind: string; viewport: string | null; relPath: string }[];
}

export interface RunStats {
  totalRuns: number;
  passRate: number;
  totalHeals: number;
  totalVisualFindings: number;
  totalA11yViolations: number;
  totalSecurityFindings: number;
  totalLlmCalls: number;
  avgDurationMs: number | null;
  /** Oldest first. */
  trend: {
    runId: string;
    planId: string;
    startedAt: string;
    status: RunStatus;
    healCount: number;
    durationMs: number | null;
  }[];
}

export interface StartedRun {
  runId: string;
  queuePosition: number;
  stream: string;
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

/**
 * The autonomous pipeline. One URL in, and the orchestrator plans, scores its own
 * coverage, re-plans for what it is missing, records, executes, heals and reports
 * with nobody between the stages.
 *
 * Mirrors `src/orchestrator/types.ts`. Mission status extends the run vocabulary
 * rather than replacing it: `queued`, `running`, `cancelled` and `error` are the
 * process states, and `passed` / `failed` / `needs_review` are the same three
 * verdicts a run reaches, so a reader who has learned one has learned both.
 */
export type MissionStage = 'explore' | 'plan' | 'evaluate_coverage' | 'generate' | 'execute' | 'report';

export type MissionStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'needs_review'
  | 'cancelled'
  | 'error';

export type MissionMode = 'autonomous' | 'supervised';

/** What the orchestrator did at a stage boundary. `outcome` is the load-bearing field. */
export type DecisionOutcome = 'ok' | 'skipped' | 'retried' | 'escalated' | 'failed';

export interface Decision {
  stage: MissionStage;
  action: string;
  reason: string;
  outcome: DecisionOutcome;
  at: string;
  durationMs: number | null;
}

/**
 * One coverage reading and what followed it.
 *
 * `followedBy` is why the series stops where it does, and the two endings mean
 * opposite things: `nothing_fillable` says the map has nothing left worth a test,
 * `budget_spent` says gaps remain and the loop ran out of rounds.
 */
export interface CoverageRound {
  round: number;
  score: number;
  gaps: number;
  refusalCovered: number;
  refusalTotal: number;
  formsCovered: number;
  formsTotal: number;
  pagesCovered: number;
  pagesTotal: number;
  followedBy: 'replanned' | 'nothing_fillable' | 'budget_spent' | 'replan_failed';
  at: string;
}

export interface FormField {
  label: string;
  inputType: string | null;
  required: boolean;
  name: string | null;
}

export interface FormSpec {
  index: number;
  fields: FormField[];
  submitLabel: string | null;
  isAuth: boolean;
  untestableHere: { kind: string; why: string }[];
  negativeOpportunities: {
    field: string;
    kind: 'empty_required' | 'malformed_email' | 'wrong_credential' | 'out_of_range';
    why: string;
  }[];
}

export interface PageState {
  url: string;
  title: string;
  elementCount: number;
  depth: number;
  forms: FormSpec[];
  links: string[];
  /** Recorded by their accessible name and deliberately never operated. */
  destructiveActions: string[];
  blindSpots: number;
  behindAuth: boolean;
}

export interface SiteMap {
  entryUrl: string;
  pages: PageState[];
  unvisited: { url: string; reason: string }[];
  auth: { wallFound: boolean; authenticated: boolean; note: string };
  budget: {
    pagesVisited: number;
    pageLimit: number;
    depthLimit: number;
    elapsedMs: number;
    exhausted: boolean;
  };
}

export interface Mission {
  missionId: string;
  status: MissionStatus;
  mode: MissionMode;
  stage: MissionStage | null;
  targetUrl: string;
  instruction: string | null;
  prd: string | null;
  planId: string | null;
  runId: string | null;
  decisions: Decision[];
  siteMap: SiteMap | null;
  coverageRounds: CoverageRound[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** The index payload. Carries counts instead of the map, which the index does not draw. */
export interface MissionSummary extends Omit<Mission, 'decisions' | 'siteMap'> {
  decisionCount: number;
  pageCount: number;
  formCount: number;
}

// ---------------------------------------------------------------------------
// The quality report
// ---------------------------------------------------------------------------

export type GapKind = 'missing_flow' | 'missing_edge_case' | 'missing_error_state' | 'unexplored';

export interface CoverageGap {
  kind: GapKind;
  where: string;
  what: string;
  why: string;
}

export interface UntestedFlowRisk {
  flow: string;
  score: number;
  band: 'low' | 'medium' | 'high';
  /** The arithmetic in words. The score is not rendered without it. */
  rationale: string;
}

export interface CoverageReport {
  covered: { pages: string[]; forms: string[]; negativePaths: string[] };
  totals: { pages: number; forms: number; negativePaths: number };
  gaps: CoverageGap[];
  untestedFlowRisk: UntestedFlowRisk[];
  score: number;
  method: string;
}

export type ScenarioKind = 'primary_journey' | 'refusal_path' | 'boundary_value' | 'uncovered_flow';

/**
 * `not_run` is neither a pass nor a failure: it means no executable baseline was
 * produced, which is a statement about this tool and not about the application.
 */
export type ScenarioVerdict = 'passed' | 'failed' | 'needs_review' | 'not_run' | 'error';

export interface Scenario {
  planId: string;
  name: string;
  intent: string;
  kind: ScenarioKind;
  stepsTotal: number;
  stepsPassed: number;
  verdict: ScenarioVerdict;
  outcome: string;
  specFile: string | null;
}

export interface ReportHealAction {
  planId: string;
  stepId: string;
  status: string;
  confidence: number | null;
  reason: string | null;
  previousLocator: string | null;
  newLocator: string | null;
  verification: string | null;
  fromCache: boolean;
}

export interface PrdGap {
  requirement: string;
  id: string;
  covered: boolean;
  coveredBy: string | null;
  basis: string;
}

export interface PrdAnalysis {
  requirementsFound: number;
  testableInBrowser: number;
  covered: number;
  gaps: PrdGap[];
  [key: string]: unknown;
}

export interface QualityReport {
  missionId: string;
  targetUrl: string;
  generatedAt: string;
  verdict: string;
  scenarios: Scenario[];
  outcomes: {
    scenariosTotal: number;
    scenariosPassed: number;
    scenariosFailed: number;
    scenariosNeedingReview: number;
    scenariosNotRun: number;
    stepsTotal: number;
    stepsPassed: number;
  };
  healActions: ReportHealAction[];
  coverage: CoverageReport | null;
  coverageNote: string;
  quality: {
    overall: number;
    parts: { name: string; score: number; weight: number; note: string }[];
    /** Never rendered apart from `overall`. An empty array is a statement, not a gap. */
    caveats: string[];
  };
  prd: PrdAnalysis | null;
  specFiles: string[];
  decisions: { stage: string; action: string; reason: string; outcome: string }[];
}

export interface StartedMission {
  missionId: string;
  status: MissionStatus;
  poll: string;
}
