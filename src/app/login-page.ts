import { createHash } from 'node:crypto';
import type { LoginPageState, PendingLogin } from '../core/azure/index.js';

const STYLE = [
  'body{font-family:system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}',
  'h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}',
  'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd}',
  'code{font-size:1.3rem;font-weight:600;letter-spacing:.08em}',
  '.muted{color:#666}',
].join('');

const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');

/** No scripts, no external assets, no framing, no forms (the page only displays). */
export const LOGIN_PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const LOGIN_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': LOGIN_PAGE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Only https links are rendered as links; anything else is shown as plain text. */
function verificationLink(uri: string | undefined): string {
  if (uri === undefined) return '<span class="muted">waiting for Microsoft…</span>';
  const safe = escapeHtml(uri);
  return /^https:\/\//i.test(uri)
    ? `<a href="${safe}" rel="noreferrer noopener" target="_blank">${safe}</a>`
    : safe;
}

function remaining(expiresOn: number | undefined, now: number): string {
  if (expiresOn === undefined) return '';
  const minutes = Math.max(0, Math.floor((expiresOn - now) / 60_000));
  return `${minutes} min`;
}

function pendingRow(p: PendingLogin, now: number): string {
  const alias = escapeHtml(p.alias);
  if (p.state === 'failed' || p.state === 'expired') {
    const why = p.state === 'expired' ? 'Code expired.' : 'Sign-in failed.';
    return `<tr><td>${alias}</td><td colspan="3" class="muted">${why} Ask the agent to run login again.</td></tr>`;
  }
  const code =
    p.userCode === undefined ? '<span class="muted">…</span>' : `<code>${escapeHtml(p.userCode)}</code>`;
  return `<tr><td>${alias}</td><td>${code}</td><td>${verificationLink(p.verificationUri)}</td><td>${remaining(p.expiresOn, now)}</td></tr>`;
}

export function renderLoginPage(state: LoginPageState, now: number = Date.now()): string {
  const pending =
    state.pending.length === 0
      ? '<p class="muted">No sign-in in progress. Ask the agent to run the <em>login</em> tool.</p>'
      : '<table><thead><tr><th>Context</th><th>Code</th><th>Sign in at</th><th>Expires in</th></tr></thead><tbody>' +
        state.pending.map((p) => pendingRow(p, now)).join('') +
        '</tbody></table>';

  const loggedIn =
    state.loggedIn.length === 0
      ? '<p class="muted">None.</p>'
      : '<table><thead><tr><th>Context</th><th>Token expires in</th></tr></thead><tbody>' +
        state.loggedIn
          .map((c) => `<tr><td>${escapeHtml(c.alias)}</td><td>${remaining(c.expiresOn, now)}</td></tr>`)
          .join('') +
        '</tbody></table>';

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="refresh" content="5">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Azure sign-in</title>',
    `<style>${STYLE}</style>`,
    '</head><body>',
    '<h1>Azure sign-in</h1>',
    '<p>Open the link, enter the code, and sign in with the account for that context. ',
    'The code is shown only here, never to the AI agent.</p>',
    '<h2>Pending sign-ins</h2>',
    pending,
    '<h2>Signed-in contexts</h2>',
    loggedIn,
    '</body></html>',
  ].join('');
}
