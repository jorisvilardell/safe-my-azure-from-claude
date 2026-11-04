export interface ServerInfoDeps {
  readonly version: string;
  /** Lazily read so the list includes every feature registered at startup. */
  readonly listFeatures: () => readonly { name: string; description: string }[];
}

export interface ServerInfo {
  name: string;
  version: string;
  guarantees: string[];
  features: { name: string; description: string }[];
}

export function buildServerInfo(deps: ServerInfoDeps): ServerInfo {
  return {
    name: 'safe-my-azure-from-claude',
    version: deps.version,
    guarantees: [
      'Read-only: no tool can modify Azure resources.',
      'Credentials never leave the server.',
      'Identifiers (GUIDs, resource IDs, emails, secrets) are anonymised; only resource names are shown.',
    ],
    features: deps.listFeatures().map(({ name, description }) => ({ name, description })),
  };
}
