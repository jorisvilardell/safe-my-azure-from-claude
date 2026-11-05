/**
 * Detection patterns used by the scrubber. The ORDER in which `scrubString` applies them is
 * documented there; it matters because later patterns must not see half-masked secrets.
 *
 * Every pattern is global and must be reset (`lastIndex`) by `String.replace`, which it is.
 *
 * Boundaries are explicit look-arounds, never `\b`: `\b` sees `_` and the hex digits of a
 * percent escape as word characters, so `DB_PASSWORD=…`, `vm_<guid>` or `%2F<guid>` slipped
 * through. Text is also percent-decoded before these patterns run (see `scrub.ts`).
 */

/** A `%XX` run (UTF-8 bytes), decoded before scanning so `%2Fsubscriptions%2F<guid>` is seen. */
export const PERCENT_RUN = /(?:%[0-9a-f]{2})+/gi;

/** JWTs (access/ID tokens), signed or not (`alg: none` has an empty third segment). */
export const JWT = /(?<![\w-])eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;

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

/** Authorization schemes. `Basic` needs a base64-looking value, so "Basic tier" is kept. */
export const BEARER = /\bBearer\s+(?!\[REDACTED\])[\w\-.~+/]+=*/gi;
export const BASIC = /\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g;

/** `scheme://user:password@host`: the password is redacted, the user and host are scrubbed. */
export const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@:]+):([^\s/?#@]+)@/gi;

/**
 * Well-known token formats, recognised on their own without a `key=` name:
 * GitHub, GitLab, npm, Slack, AWS key ids, Google API keys, Stripe, OpenAI/Anthropic, Entra ID
 * client secrets (`xxx8Q~…`), Azure DevOps PATs (52 base32 chars), and any padded base64 blob
 * of 40+ characters (storage, Cosmos DB, Service Bus, Event Hubs and Function keys).
 */
export const KNOWN_TOKEN = new RegExp(
  [
    String.raw`(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{30,})`,
    String.raw`(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}`,
    String.raw`(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`,
    String.raw`(?<![\w-])AIza[\w-]{35}`,
    String.raw`(?<![\w-])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
    String.raw`(?<![\w-])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`,
    String.raw`(?<![\w~.-])[\w~.-]{3}\dQ~[\w~.-]{31,34}(?![\w~.-])`,
    String.raw`(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])`,
    String.raw`(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={1,2}(?![A-Za-z0-9+/=])`,
  ].join('|'),
  'g',
);

/**
 * `x-ms-*` headers that carry credentials or caller identity (App Service EasyAuth
 * `x-ms-token-aad-access-token`, `x-ms-client-principal[-name|-id]`, `x-ms-authorization-auxiliary`,
 * `x-ms-encryption-key`, …). Matched by whole dash-separated segment so `x-ms-keyvault-region`
 * or `x-ms-request-id` are not caught.
 */
const X_MS_SECRET_HEADER = String.raw`x-ms(?:-[a-z0-9]+)*?-(?:token|tokens|authorization|auth|principal|secret|signature|key|credential|credentials|password)(?:-[a-z0-9]+)*`;

/** `Header: value` text form (HTTP dumps, log lines). The value runs to the end of the line. */
export const HEADER_SECRET = new RegExp(
  String.raw`(?<![A-Za-z0-9-])(${X_MS_SECRET_HEADER}|proxy-authorization|authorization|set-cookie|cookie)(\s*[:=]\s*)(?!\s*(?:Bearer\s+|Basic\s+|SharedAccessSignature\s+)?\[REDACTED\])[^\r\n"']+`,
  'gi',
);

/**
 * Names whose VALUE is a secret, matched on the END of the name, case-insensitively.
 * Suffix-based so `clientSecret`, `DB_PASSWORD`, `adminPassword`, `accessToken`, `primaryKey`,
 * `x-functions-key`, `Ocp-Apim-Subscription-Key` and `api-key` match while `secretName`,
 * `tokenType` or `keyVaultUri` do not.
 */
// The prefix is bounded: unbounded, a long `a_a_a…` token would be rescanned from every `_`.
const SECRET_NAME = String.raw`[\w.-]{0,64}?(?:password|passwd|passphrase|pwd|secret|token|credentials?|apikey|api[_-]?key|connection[_-]?string|connstr|conn[_-]str|(?:primary|secondary|master|account|access|private|encryption|signing|shared|subscription|sharedaccess|functions?|host|system|storage|client|app|admin|auth|service|webhook|sas|search|query|event[_-]?grid)[_-]?key)s?`;

const SECRET_KEY_SOURCE = String.raw`(?:${SECRET_NAME}|${X_MS_SECRET_HEADER}|proxy-authorization|authorization|set-cookie|cookie|sig|signature)`;

/** Object keys (JSON field names) whose value is a secret: the whole key must match. */
export const SECRET_KEY = new RegExp(`^${SECRET_KEY_SOURCE}$`, 'i');

/**
 * `name=value`, `name: value`, `name = value`, `"name": "value"`, `'name': 'value'` in free text
 * (connection strings, query strings, env dumps, YAML, Python reprs, log lines). The value is a
 * quoted string or runs to the next separator. Booleans, null and nested objects are left alone.
 */
export const KEY_VALUE_SECRET = new RegExp(
  String.raw`(?<![\w.-])(${SECRET_NAME}|AccountKey|SharedAccessKey)(["']?\s*[:=]\s*)(?!\[REDACTED\]|"\[REDACTED\]"|'\[REDACTED\]'|(?:true|false|null)\b|[{[])("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s;&,"'}\])]+)`,
  'gi',
);

/** `sig=` (SAS) and `code=` (Functions keys) only in `=` form: `status code: 404` is not a secret. */
export const QUERY_SECRET =
  /(?<![A-Za-z0-9])(sig|code|client_assertion|subscription-key)=(?!\[REDACTED\])([^;&\s"']+)/gi;

/** Same keys inside serialised JSON text, for values the free-text pattern above does not see. */
export const JSON_SECRET_FIELD = new RegExp(
  String.raw`("${SECRET_KEY_SOURCE}"\s*:\s*)(?:"(?!\[REDACTED\]")(?:[^"\\]|\\.)*"|(?!null\b|true\b|false\b|[{["])[^\s,}\]]+)`,
  'gi',
);

/** ARM resource ID, captured from /subscriptions/ to end of path. */
export const ARM_ID = /\/subscriptions\/[0-9a-f-]{36}(?:\/[^\s"'?,;)\]}]*)?/gi;

/**
 * GUIDs anywhere, even glued to letters, `_` or digits (`vm_<guid>`, `<guid>_backup`): a GUID is
 * never a fragment of something harmless.
 */
export const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** 32 hex digits without dashes: a GUID with its dashes removed (`replace_string(id, '-', '')`). */
export const GUID_NO_DASHES = /(?<![0-9a-z])[0-9a-f]{32}(?![0-9a-z])/gi;

/** Whole-string GUID, used to tell an app/SP id from a display name in identity fields. */
export const GUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Emails and UPNs, including Entra ID guest UPNs (`jane_contoso.com#EXT#@tenant.onmicrosoft.com`)
 * and non-ASCII local parts. The look-behind only lets a match start at the beginning of a
 * local-part token, which keeps a long `a.a.a…` run without `@` linear.
 */
export const EMAIL = /(?<![\p{L}\p{N}_.%+#-])[\p{L}\p{N}_.%+#-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu;

/**
 * IPv6 CANDIDATE: anything with 2+ colon-separated hex groups, optionally ending in a dotted
 * IPv4 (`::ffff:203.0.113.5`) and a zone (`%eth0`). Validated with `net.isIPv6` afterwards, so
 * `12:30:45` or `aa:bb:cc:dd:ee:ff` (MAC) are rejected. The look-behind refuses to start inside
 * a word (`std::map`, `Microsoft::X`) and the IPv4 tail is tried first so it is not cut short.
 */
export const IPV6_CANDIDATE =
  /(?<![A-Za-z0-9:.])(?:[0-9a-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?:%[\w.]+)?(?![A-Za-z0-9:]|\.\d)/gi;

/**
 * IPv4 CANDIDATE (octets validated in code). Rejected:
 * - inside a longer dotted or alphanumeric token: `v1.2.3.4`, `1.2.3.4.5`, `x1.2.3.4`, `1.2.3.4a`;
 * - right after `version` (`version 1.2.3.4`, `"agentVersion": "1.10.2.0"`).
 * `_`, `-` and `:` around an IP are allowed on purpose (`Allow_203.0.113.5_SSH`, `addr:203.0.113.5`).
 */
export const IPV4_CANDIDATE =
  /(?<![A-Za-z0-9.])(?<!version["']?\s*[:=]?\s*["']?)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![A-Za-z0-9]|\.\d)/gi;

/** `IPV4_CANDIDATE` without the `version` exception, for text whose wording the AI controls (KQL). */
export const IPV4_CANDIDATE_STRICT =
  /(?<![A-Za-z0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![A-Za-z0-9]|\.\d)/gi;
