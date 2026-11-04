/**
 * Detection patterns used by the scrubber. Order matters: secrets first, then ARM IDs
 * (which contain GUIDs), then bare GUIDs, then identities.
 *
 * Every pattern is global and must be reset (`lastIndex`) by `String.replace` — it is.
 */

/** JWTs (access/ID tokens). */
export const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g;

/** PEM private keys / certificates. */
export const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;

/** key=value secrets in connection strings / query strings. */
export const KEY_VALUE_SECRET =
  /\b(AccountKey|SharedAccessKey|SharedAccessSignature|sig|password|pwd|client_secret|access_token|refresh_token|code)=([^;&\s"']+)/gi;

/** Authorization headers. */
export const BEARER = /\bBearer\s+[\w\-.~+/]+=*/gi;

/** ARM resource ID, captured from /subscriptions/ to end of path. */
export const ARM_ID = /\/subscriptions\/[0-9a-f-]{36}(?:\/[^\s"'?,;)\]}]*)?/gi;

export const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const EMAIL = /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
