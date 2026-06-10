/**
 * Persisted plugin configuration. Stored via Plugin.loadData/saveData in the
 * plugin's data.json - which holds credentials/session tokens, so it is
 * gitignored and should not live inside a synced vault folder you also publish.
 */
export interface PdsSyncSettings {
	/** "oauth" (recommended) or "app-password" (universal fallback). */
	authMode: "oauth" | "app-password";

	// --- OAuth ---
	/** Public HTTPS URL serving the client metadata document. */
	oauthClientId: string;
	/** Redirect URL (same origin as client_id) that bounces back to obsidian://. */
	oauthRedirectUri: string;
	/** Last signed-in DID, for resuming the OAuth session on reload. */
	oauthDid: string;

	// --- App password ---
	/** PDS service URL, e.g. https://bsky.social. */
	service: string;
	/** Handle or DID used to sign in (both modes use this as the login hint). */
	identifier: string;
	/** App password - keychain fallback only (empty when SecretStorage is used). */
	appPassword: string;

	// --- Sync behaviour ---
	publicCollection: string;
	/** AT-URI of the site.standard.publication that documents belong to. */
	publicationUri: string;
	/** Fields for the "create publication" helper. */
	publicationName: string;
	publicationUrl: string;
	publicationDescription: string;
	publicationRkey: string;
	/** Vault-relative path to an image used as the publication icon (optional). */
	publicationIconPath: string;
	publicationShowInDiscover: boolean;
	/** Emit a custom publication theme from the colours below. */
	publicationThemeEnabled: boolean;
	/** Theme colours as #rrggbb (from the colour pickers). */
	publicationTheme: {
		background: string;
		foreground: string;
		accent: string;
		accentForeground: string;
	};
	privateCollection: string;
	/** E2EE passphrase - keychain fallback only (empty when SecretStorage is used). */
	e2eePassphrase: string;
	/** Limit syncing to this vault folder; empty = whole vault. */
	syncFolder: string;
	/** Push changed notes automatically (debounced) when they're edited. */
	autoSyncOnChange: boolean;
	/** Push the whole vault every N minutes (0 = off). */
	autoSyncIntervalMinutes: number;
}

/** Collection holding the publication record. */
export const PUBLICATION_COLLECTION = "site.standard.publication";

export const DEFAULT_SETTINGS: PdsSyncSettings = {
	authMode: "app-password",
	oauthClientId: "https://obsidian-pds-sync.2877686.xyz/client-metadata.json",
	oauthRedirectUri: "https://obsidian-pds-sync.2877686.xyz/callback.html",
	oauthDid: "",
	service: "https://bsky.social",
	identifier: "",
	appPassword: "",
	publicCollection: "site.standard.document",
	publicationUri: "",
	publicationName: "",
	publicationUrl: "",
	publicationDescription: "",
	publicationRkey: "self",
	publicationIconPath: "",
	publicationShowInDiscover: true,
	publicationThemeEnabled: false,
	publicationTheme: {
		background: "#ffffff",
		foreground: "#1a1a1a",
		accent: "#3b6fed",
		accentForeground: "#ffffff",
	},
	privateCollection: "app.pdssync.note",
	e2eePassphrase: "",
	syncFolder: "",
	autoSyncOnChange: false,
	autoSyncIntervalMinutes: 0,
};

/** OAuth scope string. Must be a subset of the scope declared in client-metadata.json. */
export function buildScope(s: PdsSyncSettings): string {
	return `atproto repo:${s.publicCollection} repo:${PUBLICATION_COLLECTION} repo:${s.privateCollection} blob:*/*`;
}
