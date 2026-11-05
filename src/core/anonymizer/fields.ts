import { SECRET_KEY } from './patterns.js';

/**
 * Field-name rules for the deep scrubber. Keys are compared lowercased and, for claim URIs
 * such as `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name`, by their last segment.
 */
export function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash === -1 ? lower : lower.slice(slash + 1);
}

/** Service principal / app registration ids → `app-NNN`. */
const APP_ID_KEYS = new Set(['appid', 'applicationid', 'clientid', 'client_id', 'serviceprincipalid', 'azp']);

/** Fields holding a person or caller, whatever the surrounding object → `user-NNN` (or `app-NNN` for a GUID). */
const USER_KEYS = new Set([
  'caller',
  'principalname',
  'userprincipalname',
  'upn',
  'signinname',
  'unique_name',
  'uniquename',
  'createdby',
  'lastmodifiedby',
  'emailaddress',
  'adminusername',
  'owner',
  'owners',
]);

/**
 * Fields that are a person's name only inside an identity context. Outside one, `displayName`
 * or `name` are usually resource / alert rule names and are kept.
 */
const USER_KEYS_IN_IDENTITY = new Set([
  'displayname',
  'name',
  'givenname',
  'given_name',
  'surname',
  'family_name',
  'nameidentifier',
  'puid',
]);

/** Object keys whose value describes a principal. */
const IDENTITY_CONTAINER_KEYS = new Set([
  'identity',
  'principal',
  'user',
  'caller',
  'claims',
  'actor',
  'initiatedby',
  'createdby',
  'lastmodifiedby',
  'owner',
  'owners',
  'serviceprincipal',
  'signedinuser',
  'requester',
  'assignee',
  'assignedto',
]);

/** Sibling keys that mark the current object as describing a principal. */
const IDENTITY_MARKER_KEYS = new Set(['principalid', 'principaltype', 'userprincipalname', 'appid']);

/**
 * Secret-looking keys whose OBJECT value is not a secret. The activity log's `authorization`
 * is `{ action, scope, evidence }`: the RBAC check behind an operation. It is scrubbed as usual.
 */
const NON_SECRET_OBJECT_KEYS = new Set(['authorization']);

export const isSecretKey = (key: string): boolean => SECRET_KEY.test(key);
export const isNonSecretObjectKey = (nk: string): boolean => NON_SECRET_OBJECT_KEYS.has(nk);
export const isAppIdKey = (nk: string): boolean => APP_ID_KEYS.has(nk);
export const isTagsKey = (nk: string): boolean => nk === 'tags';
/**
 * Known Azure version fields, whose dotted values (`1.10.2.0`) are not IPs. An exact list, not
 * a `*version` suffix: data keys (dynamic KQL columns, metric dimensions) could otherwise be
 * named `xversion` on purpose to get a public IP through unmasked.
 */
const VERSION_KEYS = new Set([
  'version',
  'osversion',
  'agentversion',
  'typehandlerversion',
  'kubernetesversion',
  'currentkubernetesversion',
  'orchestratorversion',
  'imageversion',
  'nodeimageversion',
  'minimumtlsversion',
  'minimaltlsversion',
  'mintlsversion',
  'tlsversion',
  'apiversion',
  'schemaversion',
  'contentversion',
  'sdkversion',
  'runtimeversion',
  'platformversion',
  'extensionversion',
  'appversion',
  'frameworkversion',
  'engineversion',
  'serverversion',
  'majorversion',
  'minorversion',
]);
export const isVersionKey = (nk: string): boolean => VERSION_KEYS.has(nk);

export function isUserKey(nk: string, inIdentity: boolean): boolean {
  return USER_KEYS.has(nk) || (inIdentity && USER_KEYS_IN_IDENTITY.has(nk));
}

export function isIdentityContext(parentKey: string | undefined, obj: object): boolean {
  if (parentKey !== undefined && IDENTITY_CONTAINER_KEYS.has(parentKey)) return true;
  return Object.keys(obj).some((k) => IDENTITY_MARKER_KEYS.has(normalizeKey(k)));
}
