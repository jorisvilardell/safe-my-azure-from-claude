/**
 * Detection patterns used by the scrubber. The ORDER in which `scrubString` applies them is
 * documented there; it matters because later patterns must not see half-masked secrets.
 *
 * Every pattern is global and must be reset (`lastIndex`) by `String.replace`, which it is.
 */

/** JWTs (access/ID tokens). */
export const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g;

/** Complete PEM blocks: every `PRIVATE KEY` flavour (RSA, EC, OPENSSH, ENCRYPTED, PGP…) and certificates. */
export const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

/**
 * A private key whose END marker is missing (truncated log line, capped output). Everything
 * after BEGIN is key material, so redact to the end of the string.
 */
export const PEM_UNTERMINATED = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*/g;

/**
 * `SharedAccessSignature=` in a connection string. The value is a whole SAS token that may
 * itself contain `&`, `=` and spaces (`SharedAccessSignature sr=…&sig=…`), so consume up to `;`.
 */
export const SAS_CONNECTION_STRING = /\bSharedAccessSignature=[^;"'\r\n]+/gi;

/** Service Bus / Event Hubs / IoT `Authorization: SharedAccessSignature sr=…&sig=…&skn=…`. */
export const SAS_TOKEN = /\bSharedAccessSignature\s+(?!\[REDACTED\])[^\s;"',]+/gi;

/** key=value secrets in connection strings / query strings. */
export const KEY_VALUE_SECRET =
  /\b(AccountKey|SharedAccessKey|sig|password|pwd|secret|client_secret|client_assertion|access_token|refresh_token|id_token|apikey|api_key|code)=([^;&\s"']+)/gi;

/** Authorization headers. */
export const BEARER = /\bBearer\s+[\w\-.~+/]+=*/gi;

/**
 * `x-ms-*` headers that carry credentials or caller identity (App Service EasyAuth
 * `x-ms-token-aad-access-token`, `x-ms-client-principal[-name|-id]`, `x-ms-authorization-auxiliary`,
 * `x-ms-encryption-key`, …). Matched by whole dash-separated segment so `x-ms-keyvault-region`
 * or `x-ms-request-id` are not caught.
 */
const X_MS_SECRET_HEADER = String.raw`x-ms(?:-[a-z0-9]+)*?-(?:token|tokens|authorization|auth|principal|secret|signature|key|credential|credentials|password)(?:-[a-z0-9]+)*`;

/** `Header: value` text form (HTTP dumps, log lines). The value runs to the end of the line. */
export const HEADER_SECRET = new RegExp(
  String.raw`\b(${X_MS_SECRET_HEADER}|proxy-authorization|authorization|set-cookie|cookie)(\s*[:=]\s*)(?!\s*(?:Bearer\s+|SharedAccessSignature\s+)?\[REDACTED\])[^\r\n"']+`,
  'gi',
);

/**
 * Object keys (JSON field names) whose VALUE is a secret. Matched against the full key,
 * case-insensitively. Suffix-based so `clientSecret`, `adminPassword`, `accessToken`,
 * `primaryKey` match while `secretName`, `tokenType`, `keyVaultUri` do not.
 */
const SECRET_KEY_SOURCE = String.raw`(?:[\w.-]*(?:password|passwd|pwd|secret|token|credential|apikey|api[_-]key|(?:primary|secondary|master|account|access|private|encryption|signing|shared|subscription|sharedaccess)[_-]?key)s?|${X_MS_SECRET_HEADER}|proxy-authorization|authorization|set-cookie|cookie|sig|signature)`;

export const SECRET_KEY = new RegExp(`^${SECRET_KEY_SOURCE}$`, 'i');

/**
 * Same keys inside serialised JSON text (`"password": "…"`, `"clientSecret":"…"`). Object values
 * (`"authorization": {…}` in the activity log) and null/booleans are left for the other passes.
 */
export const JSON_SECRET_FIELD = new RegExp(
  String.raw`("${SECRET_KEY_SOURCE}"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|(?!null\b|true\b|false\b|[{[])[^\s,}\]]+)`,
  'gi',
);

/** ARM resource ID, captured from /subscriptions/ to end of path. */
export const ARM_ID = /\/subscriptions\/[0-9a-f-]{36}(?:\/[^\s"'?,;)\]}]*)?/gi;

export const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Whole-string GUID, used to tell an app/SP id from a display name in identity fields. */
export const GUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The look-behind (instead of `\b`) only lets a match start at the beginning of a local-part
 * token. With `\b` a long `a.a.a.a…` run without `@` was retried at every dot: quadratic time.
 */
export const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

/**
 * IPv6 CANDIDATE: anything with 2+ colon-separated hex groups, optionally ending in a dotted
 * IPv4 (`::ffff:203.0.113.5`) and a zone (`%eth0`). Validated with `net.isIPv6` afterwards, so
 * `12:30:45` or `aa:bb:cc:dd:ee:ff` (MAC) are rejected. The look-behind refuses to start inside
 * a word (`std::map`, `Microsoft::X`) and the IPv4 tail is tried first so it is not cut short.
 */
export const IPV6_CANDIDATE =
  /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?:%[\w.]+)?(?![\w:]|\.\d)/gi;

/**
 * IPv4 CANDIDATE (octets validated in code). Rejected:
 * - inside a longer dotted/word token: `v1.2.3.4`, `1.2.3.4.5`, `x1.2.3.4`, `1.2.3.4a`;
 * - right after `version` (`version 1.2.3.4`, `"agentVersion": "1.10.2.0"`).
 * `-` and `:` before an IP are allowed on purpose (`ip-203.0.113.5`, `addr:203.0.113.5`).
 */
export const IPV4_CANDIDATE =
  /(?<![\w.])(?<!version["']?\s*[:=]?\s*["']?)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\d)/gi;
