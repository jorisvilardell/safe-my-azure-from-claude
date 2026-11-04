import { AzureLogger, setLogLevel as setAzureLogLevel } from '@azure/logger';
import { TypeSpecRuntimeLogger, setLogLevel as setTypeSpecRuntimeLogLevel } from '@typespec/ts-http-runtime';

const discard = (): void => undefined;

/**
 * Turns off the Azure SDK's own logging, whatever `AZURE_LOG_LEVEL`, `TYPESPEC_RUNTIME_LOG_LEVEL`
 * or `DEBUG` say. Those logs (identity, MSAL, HTTP pipeline) write straight to stderr with request
 * URLs, tenant and subscription IDs and account names, bypassing our scrubbing logger (R5).
 *
 * Lowering the level is not enough on its own: the env vars are read when the SDK is imported,
 * and any later `setLogLevel()` would turn it back on. So the sink is replaced too. Every SDK
 * client logger forwards to `AzureLogger.log` (or `TypeSpecRuntimeLogger.log`) at call time.
 * Call it once, at startup, before any credential or client is created.
 */
export function silenceAzureSdkLogging(): void {
  setAzureLogLevel();
  setTypeSpecRuntimeLogLevel();
  AzureLogger.log = discard;
  TypeSpecRuntimeLogger.log = discard;
}
