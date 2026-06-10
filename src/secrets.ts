import type { App } from "obsidian";

/**
 * Credential storage backed by Obsidian's SecretStorage (OS keychain - macOS
 * Keychain, Windows Credential Manager, Linux libsecret; since Obsidian 1.11.4),
 * with a plaintext-settings fallback for older versions / platforms without it.
 *
 * IDs are fixed and plugin-namespaced so they don't collide with other plugins'
 * shared secrets and load automatically - the user never names them.
 */

export const SECRET_APP_PASSWORD = "pds-sync-app-password";
export const SECRET_E2EE_PASSPHRASE = "pds-sync-e2ee-passphrase";

function storage(app: App): App["secretStorage"] | undefined {
	return (app as Partial<App>).secretStorage;
}

export function keychainAvailable(app: App): boolean {
	return storage(app) != null;
}

export function readSecret(app: App, id: string, fallback: string): string {
	const ss = storage(app);
	if (ss) return ss.getSecret(id) ?? "";
	return fallback;
}

/**
 * Persist a secret. Returns true if it was stored in the keychain - in which
 * case the caller must NOT also keep it in plaintext settings.
 */
export function writeSecret(app: App, id: string, value: string): boolean {
	const ss = storage(app);
	if (!ss) return false;
	ss.setSecret(id, value);
	return true;
}
