import type { Page, Response } from 'playwright';

/**
 * Passive security observation.
 *
 * Strictly passive: everything here is read from responses the run was going to
 * make anyway, plus the DOM it was going to render anyway. Nothing is injected,
 * nothing is fuzzed, no payload is sent.
 *
 * That is a deliberate limit, not an unfinished one. The moment a QA tool starts
 * probing it becomes a scanner, and a scanner pointed at a URL somebody typed into
 * a text box is a tool for attacking third parties. Passive checks find the flaws
 * that actually turn up in real applications — a missing header, a cookie without
 * flags, a key committed into a bundle — without that.
 */

export type SecuritySeverity = 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  title: string;
  detail: string;
  /** Where it was observed, so it can be found again. */
  evidence: string;
  remediation: string;
}

export interface SecurityAudit {
  pagePath: string;
  findings: SecurityFinding[];
  bySeverity: Record<SecuritySeverity, number>;
  /** Weighted, for the same reason the accessibility score is. */
  score: number;
}

const SEVERITY_WEIGHT: Record<SecuritySeverity, number> = {
  high: 15,
  medium: 7,
  low: 3,
  info: 0,
};

/**
 * Response headers worth having, and what their absence actually allows.
 *
 * Deliberately not "every header a scanner knows about". Each of these has a
 * concrete consequence that can be stated in one sentence, because a finding a
 * developer cannot act on is a finding they will learn to skip.
 */
const HEADER_CHECKS: {
  header: string;
  severity: SecuritySeverity;
  title: string;
  detail: string;
  remediation: string;
}[] = [
  {
    header: 'content-security-policy',
    severity: 'high',
    title: 'No Content-Security-Policy',
    detail:
      'Nothing constrains where scripts may be loaded from, so any injected markup that ' +
      'reaches the page can execute.',
    remediation: "Start with `default-src 'self'` and widen it only where a page genuinely needs to.",
  },
  {
    header: 'strict-transport-security',
    severity: 'medium',
    title: 'No Strict-Transport-Security',
    detail:
      'A first request over http can be intercepted before the redirect to https is ever seen.',
    remediation: 'Send `max-age=31536000; includeSubDomains` on https responses.',
  },
  {
    header: 'x-content-type-options',
    severity: 'low',
    title: 'No X-Content-Type-Options',
    detail:
      'The browser may sniff a response body and treat an upload as script rather than as the ' +
      'declared type.',
    remediation: 'Send `nosniff`.',
  },
  {
    header: 'referrer-policy',
    severity: 'low',
    title: 'No Referrer-Policy',
    detail: 'Full URLs, including anything identifying in a path, leak to every third party linked to.',
    remediation: 'Send `strict-origin-when-cross-origin`.',
  },
];

function hasFrameProtection(headers: Record<string, string>): boolean {
  if (headers['x-frame-options']) return true;
  const csp = headers['content-security-policy'] ?? '';
  return csp.includes('frame-ancestors');
}

/**
 * Patterns for credentials that end up in shipped source.
 *
 * Anchored on real key shapes rather than on the word "key", because a page that
 * mentions "api key" in prose is not a leak and flagging it teaches people to
 * ignore this check.
 */
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'Assigned secret literal',
    pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-!@#$%^&*]{12,}["']/i,
  },
];

interface DomSecuritySignals {
  insecureFormActions: string[];
  mixedContent: string[];
  passwordAutocomplete: string[];
  secretsInSource: { name: string; sample: string }[];
  targetBlankWithoutRel: string[];
}

interface SerialisedPattern {
  name: string;
  source: string;
  flags: string;
}

/** Reads the DOM-side signals in one pass. */
async function domSignals(page: Page): Promise<DomSecuritySignals> {
  // Regexes cannot cross into the page context, so they are sent as source and
  // flags and rebuilt on the other side.
  const patternSources: SerialisedPattern[] = SECRET_PATTERNS.map((entry) => ({
    name: entry.name,
    source: entry.pattern.source,
    flags: entry.pattern.flags,
  }));

  return page.evaluate((patterns) => {
    const isHttps = window.location.protocol === 'https:';

    const insecureFormActions = [...document.querySelectorAll('form[action]')]
      .map((form) => form.getAttribute('action') ?? '')
      .filter((action) => action.startsWith('http://'));

    const mixedContent = isHttps
      ? [...document.querySelectorAll('img[src],script[src],link[href],iframe[src]')]
          .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
          .filter((url) => url.startsWith('http://'))
      : [];

    // A password field that offers to be remembered on a shared machine. Only
    // `current-password`, `new-password` and `off` are acceptable here.
    const passwordAutocomplete = [...document.querySelectorAll('input[type="password"]')]
      .filter((input) => {
        const value = (input.getAttribute('autocomplete') ?? '').toLowerCase();
        return !['off', 'current-password', 'new-password'].includes(value);
      })
      .map((input) => input.getAttribute('id') || input.getAttribute('name') || 'password field');

    // window.opener lets the opened page navigate this one. Modern browsers imply
    // noopener, but an explicit rel is still what an audit can verify.
    const targetBlankWithoutRel = [...document.querySelectorAll('a[target="_blank"]')]
      .filter((anchor) => !(anchor.getAttribute('rel') ?? '').includes('noopener'))
      .map((anchor) => anchor.getAttribute('href') ?? 'link');

    const source = document.documentElement.outerHTML;
    const secretsInSource: { name: string; sample: string }[] = [];
    for (const { name, source: patternSource, flags } of patterns) {
      const match = new RegExp(patternSource, flags).exec(source);
      if (match) {
        // Truncated deliberately. A finding that prints the whole credential has
        // copied it into the run record and any log that record reaches.
        secretsInSource.push({ name, sample: `${match[0].slice(0, 12)}...` });
      }
    }

    return {
      insecureFormActions,
      mixedContent,
      passwordAutocomplete,
      secretsInSource,
      targetBlankWithoutRel,
    };
  }, patternSources);
}

export interface AuditSecurityParams {
  page: Page;
  pagePath: string;
  /** The main document response for this page, when one was observed. */
  documentResponse: Response | null;
}

export async function auditSecurity({
  page,
  pagePath,
  documentResponse,
}: AuditSecurityParams): Promise<SecurityAudit> {
  const findings: SecurityFinding[] = [];

  const headers: Record<string, string> = documentResponse
    ? await documentResponse.allHeaders().catch(() => ({}))
    : {};
  const lowerHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lowerHeaders[key.toLowerCase()] = value;

  if (documentResponse) {
    for (const check of HEADER_CHECKS) {
      if (lowerHeaders[check.header]) continue;
      findings.push({
        id: `header:${check.header}`,
        severity: check.severity,
        title: check.title,
        detail: check.detail,
        evidence: `No ${check.header} on the response for ${pagePath}.`,
        remediation: check.remediation,
      });
    }

    if (!hasFrameProtection(lowerHeaders)) {
      findings.push({
        id: 'header:frame-protection',
        severity: 'medium',
        title: 'No clickjacking protection',
        detail: 'The page can be framed by another site and layered under an invisible overlay.',
        evidence: `Neither X-Frame-Options nor a CSP frame-ancestors directive on ${pagePath}.`,
        remediation: "Send `X-Frame-Options: DENY`, or `frame-ancestors 'self'` in the CSP.",
      });
    }

    // Cookie flags, read from the response rather than the jar so the audit sees
    // what the server actually sent.
    const setCookies = (lowerHeaders['set-cookie'] ?? '').split('\n').filter(Boolean);
    for (const cookie of setCookies) {
      const name = cookie.split('=')[0]?.trim() ?? 'cookie';
      const flags = cookie.toLowerCase();
      const missing: string[] = [];
      if (!flags.includes('httponly')) missing.push('HttpOnly');
      if (!flags.includes('secure')) missing.push('Secure');
      if (!flags.includes('samesite')) missing.push('SameSite');

      if (missing.length > 0) {
        findings.push({
          id: `cookie:${name}`,
          severity: missing.includes('HttpOnly') ? 'high' : 'medium',
          title: `Session cookie "${name}" is missing ${missing.join(', ')}`,
          detail: missing.includes('HttpOnly')
            ? 'Without HttpOnly the cookie is readable by any script on the page, so a single ' +
              'injection is enough to take the session.'
            : 'Without these flags the cookie can travel over http or be attached to a ' +
              'cross-site request.',
          evidence: `Set-Cookie for "${name}" on ${pagePath}.`,
          remediation: 'Send `HttpOnly; Secure; SameSite=Lax` on session cookies.',
        });
      }
    }
  }

  const dom = await domSignals(page).catch(() => null);

  if (dom) {
    for (const action of dom.insecureFormActions.slice(0, 3)) {
      findings.push({
        id: `form:insecure:${action}`,
        severity: 'high',
        title: 'Form submits over http',
        detail: 'Everything typed into this form, including credentials, is sent in the clear.',
        evidence: `Form action "${action}" on ${pagePath}.`,
        remediation: 'Post to https.',
      });
    }

    for (const url of dom.mixedContent.slice(0, 3)) {
      findings.push({
        id: `mixed:${url}`,
        severity: 'medium',
        title: 'Mixed content on a secure page',
        detail: 'A subresource loaded over http can be replaced in transit.',
        evidence: `${url} on ${pagePath}.`,
        remediation: 'Load every subresource over https.',
      });
    }

    for (const field of dom.passwordAutocomplete.slice(0, 3)) {
      findings.push({
        id: `autocomplete:${field}`,
        severity: 'low',
        title: 'Password field allows generic autocomplete',
        detail: 'A browser may store and refill the password on a shared machine.',
        evidence: `Password input "${field}" on ${pagePath}.`,
        remediation: 'Set `autocomplete="current-password"` or `"new-password"`.',
      });
    }

    for (const secret of dom.secretsInSource) {
      findings.push({
        id: `secret:${secret.name}`,
        severity: 'high',
        title: `Possible ${secret.name} in the page source`,
        detail:
          'A credential served to the browser is public. Anyone who loads the page has it, and ' +
          'rotating it is the only remedy.',
        // Truncated on purpose: a finding that prints the credential has copied it
        // into the run record and every log that record reaches.
        evidence: `Matched "${secret.sample}" in the document source for ${pagePath}.`,
        remediation: 'Move the call server-side and rotate the exposed credential.',
      });
    }

    for (const href of dom.targetBlankWithoutRel.slice(0, 2)) {
      findings.push({
        id: `target-blank:${href}`,
        severity: 'low',
        title: 'Link opens a new tab without rel="noopener"',
        detail: 'The opened page keeps a handle on this one and can navigate it elsewhere.',
        evidence: `Link to "${href}" on ${pagePath}.`,
        remediation: 'Add `rel="noopener noreferrer"`.',
      });
    }
  }

  const bySeverity: Record<SecuritySeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  let weighted = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    weighted += SEVERITY_WEIGHT[finding.severity];
  }

  return {
    pagePath,
    findings,
    bySeverity,
    score: Math.max(0, 100 - weighted),
  };
}
