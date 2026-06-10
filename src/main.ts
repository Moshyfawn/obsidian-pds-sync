import {
	App,
	debounce,
	type Debouncer,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	normalizePath,
	type ObsidianProtocolData,
	type TAbstractFile,
	TFile,
} from "obsidian";
import { AtpClient } from "./atproto/client";
import {
	finishOAuthLogin,
	loginPassword,
	resumeOAuth,
	setupOAuth,
	startOAuthLogin,
} from "./atproto/auth";
import {
	keychainAvailable,
	readSecret,
	writeSecret,
	SECRET_APP_PASSWORD,
	SECRET_E2EE_PASSPHRASE,
} from "./secrets";
import { deriveKey } from "./crypto/e2ee";
import {
	buildScope,
	DEFAULT_SETTINGS,
	PUBLICATION_COLLECTION,
	type PdsSyncSettings,
} from "./settings";
import { SyncEngine, type SyncOutcome } from "./sync/engine";
import { readIndex, type SyncIndex } from "./sync/frontmatter";
import type { SyncTarget, TargetId } from "./sync/target";
import { StandardSiteTarget } from "./sync/targets/standardSite";
import { E2eePdsTarget } from "./sync/targets/e2eePds";
import { AtsSpaceTarget } from "./sync/targets/atsSpace";

const PROTOCOL_ACTION = "pds-sync";

export default class PdsSyncPlugin extends Plugin {
	settings!: PdsSyncSettings;
	client!: AtpClient;
	private e2eeKey: CryptoKey | null = null;
	private settingTab?: PdsSyncSettingTab;
	private statusBarEl?: HTMLElement;
	private dirty = new Set<string>();
	private autoSyncDebounced?: Debouncer<[], void>;
	private intervalId: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.migrateSecretsToKeychain();
		this.client = new AtpClient();

		if (this.settings.authMode === "oauth") {
			setupOAuth(
				this.settings.oauthClientId,
				this.settings.oauthRedirectUri,
			);
		}

		// Catch the OAuth callback bounced from the HTTPS redirect page.
		this.registerObsidianProtocolHandler(
			PROTOCOL_ACTION,
			(params) => void this.handleOAuthCallback(params),
		);

		// When a synced note is deleted from the vault, delete its remote record.
		this.registerEvent(
			this.app.metadataCache.on("deleted", (_file, prevCache) => {
				const idx = readIndex(prevCache?.frontmatter);
				if (idx) void this.deleteRemoteRecord(idx);
			}),
		);

		// Resume an existing session silently.
		await this.ensureLogin(true);

		this.addRibbonIcon(
			"refresh-cw",
			"Sync vault to PDS",
			() => void this.runSyncVault(),
		);

		this.addCommand({
			id: "connect",
			name: "Connect to PDS (sign in)",
			callback: () => void this.connect(),
		});
		this.addCommand({
			id: "sync-vault",
			name: "Sync vault to PDS",
			callback: () => void this.runSyncVault(),
		});
		this.addCommand({
			id: "pull-from-pds",
			name: "Pull from PDS (restore)",
			callback: () => void this.runPull(),
		});
		this.addCommand({
			id: "create-publication",
			name: "Create / update standard.site publication",
			callback: () => void this.createPublication(),
		});
		this.addCommand({
			id: "publication-verification",
			name: "Copy publication verification (.well-known)",
			callback: () => void this.copyVerification(),
		});
		this.addCommand({
			id: "sync-current-note",
			name: "Sync current note to PDS",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const ok = !!file && file.extension === "md";
				if (ok && !checking) void this.runSyncFile(file as TFile);
				return ok;
			},
		});

		this.settingTab = new PdsSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Status bar + auto-sync (push-only; pull stays manual).
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("mod-clickable");
		this.registerDomEvent(
			this.statusBarEl,
			"click",
			() => void this.runSyncVault(),
		);
		this.setStatus(this.client.isLoggedIn ? "idle" : "off");
		this.autoSyncDebounced = debounce(
			() => void this.flushAutoSync(),
			4000,
			true,
		);
		this.registerEvent(
			this.app.vault.on("modify", (f) => this.onVaultChange(f)),
		);
		this.registerEvent(
			this.app.vault.on("create", (f) => this.onVaultChange(f)),
		);
		this.applyAutoSyncInterval();
	}

	onunload(): void {
		this.autoSyncDebounced?.cancel();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async deriveE2eeKey(): Promise<void> {
		const passphrase = readSecret(
			this.app,
			SECRET_E2EE_PASSPHRASE,
			this.settings.e2eePassphrase,
		);
		const did = this.client?.did;
		// Salt is derived from the DID, so the key needs an active session.
		this.e2eeKey =
			passphrase && did ? await deriveKey(passphrase, did) : null;
	}

	/** Run after a session is attached. Derives the E2EE key (salt comes from the DID). */
	private async afterConnect(): Promise<void> {
		await this.deriveE2eeKey();
	}

	/** One-time move of any plaintext secrets in data.json into the keychain. */
	private async migrateSecretsToKeychain(): Promise<void> {
		if (!keychainAvailable(this.app)) return;
		let changed = false;
		if (this.settings.appPassword) {
			writeSecret(
				this.app,
				SECRET_APP_PASSWORD,
				this.settings.appPassword,
			);
			this.settings.appPassword = "";
			changed = true;
		}
		if (this.settings.e2eePassphrase) {
			writeSecret(
				this.app,
				SECRET_E2EE_PASSPHRASE,
				this.settings.e2eePassphrase,
			);
			this.settings.e2eePassphrase = "";
			changed = true;
		}
		if (changed) await this.saveSettings();
	}

	private buildTargets(): Map<TargetId, SyncTarget> {
		const targets = new Map<TargetId, SyncTarget>();
		targets.set(
			"standard-site",
			new StandardSiteTarget(
				this.settings.publicCollection,
				this.settings.publicationUri,
			),
		);
		targets.set(
			"e2ee-pds",
			new E2eePdsTarget(this.settings.privateCollection, this.e2eeKey),
		);
		targets.set("ats-space", new AtsSpaceTarget());
		return targets;
	}

	private engine(): SyncEngine {
		return new SyncEngine(
			this.app,
			this.client,
			this.settings,
			this.buildTargets(),
		);
	}

	/** Resume/refresh an existing session if possible. App-password can auto-login. */
	async ensureLogin(silent = false): Promise<boolean> {
		if (this.client.isLoggedIn) return true;

		if (this.settings.authMode === "oauth") {
			setupOAuth(
				this.settings.oauthClientId,
				this.settings.oauthRedirectUri,
			);
			if (this.settings.oauthDid) {
				try {
					const { rpc, did } = await resumeOAuth(
						this.settings.oauthDid,
					);
					this.client.attach(rpc, did);
					await this.client.ensureHandle();
					await this.afterConnect();
					return true;
				} catch (err) {
					console.warn("[pds-sync] OAuth resume failed:", err);
				}
			}
			if (!silent)
				new Notice(
					"PDS Sync: run “Connect to PDS” to sign in with OAuth.",
				);
			return false;
		}

		// App-password mode - re-login from the (keychain'd) password each launch.
		const password = readSecret(
			this.app,
			SECRET_APP_PASSWORD,
			this.settings.appPassword,
		);
		if (this.settings.identifier && password) {
			return this.loginWithPassword(silent);
		}
		if (!silent)
			new Notice(
				"PDS Sync: enter your handle and app password in settings.",
			);
		return false;
	}

	private async loginWithPassword(silent = false): Promise<boolean> {
		try {
			const password = readSecret(
				this.app,
				SECRET_APP_PASSWORD,
				this.settings.appPassword,
			);
			const { rpc, did, handle } = await loginPassword({
				service: this.settings.service,
				identifier: this.settings.identifier,
				password,
			});
			this.client.attach(rpc, did, handle);
			await this.afterConnect();
			return true;
		} catch (err) {
			if (!silent) new Notice(`PDS Sync: ${msg(err)}`);
			return false;
		}
	}

	/** User-initiated sign-in. */
	async connect(): Promise<void> {
		if (this.settings.authMode === "oauth") {
			if (!this.settings.identifier) {
				new Notice("PDS Sync: enter your handle in settings first.");
				return;
			}
			try {
				setupOAuth(
					this.settings.oauthClientId,
					this.settings.oauthRedirectUri,
				);
				const url = await startOAuthLogin(
					this.settings.identifier,
					buildScope(this.settings),
				);
				// Give atcute a moment to persist PKCE/state to localStorage before we leave.
				await sleep(150);
				openExternal(url.toString());
				new Notice("PDS Sync: continue sign-in in your browser…");
			} catch (err) {
				new Notice(`PDS Sync: ${msg(err)}`);
			}
		} else {
			const ok = await this.loginWithPassword(false);
			if (ok)
				new Notice(
					`PDS Sync: connected as ${this.client.handle ?? this.client.did}`,
				);
			this.setStatus(this.client.isLoggedIn ? "idle" : "off");
		}
	}

	private async handleOAuthCallback(
		params: ObsidianProtocolData,
	): Promise<void> {
		const search = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) {
			if (k !== "action" && typeof v === "string") search.set(k, v);
		}
		if (!search.has("code") && !search.has("error")) return;
		try {
			setupOAuth(
				this.settings.oauthClientId,
				this.settings.oauthRedirectUri,
			);
			const { rpc, did } = await finishOAuthLogin(search);
			this.client.attach(rpc, did);
			await this.client.ensureHandle();
			await this.afterConnect();
			this.settings.oauthDid = did;
			await this.saveSettings();
			new Notice(`PDS Sync: connected as ${this.client.handle ?? did}`);
			this.setStatus("idle");
			this.settingTab?.display(); // refresh the (possibly open) settings pane
		} catch (err) {
			new Notice(`PDS Sync: sign-in failed - ${msg(err)}`);
		}
	}

	async runSyncVault(): Promise<void> {
		if (!(await this.ensureLogin())) {
			this.setStatus("off");
			return;
		}
		new Notice("PDS Sync: syncing vault…");
		this.setStatus("syncing");
		const outcome = await this.engine().syncVault();
		this.setStatus(outcome.failed > 0 ? "error" : "idle");
		this.notify(outcome);
	}

	private setStatus(state: "off" | "idle" | "syncing" | "error"): void {
		if (!this.statusBarEl) return;
		const map: Record<typeof state, [string, string]> = {
			off: ["cloud-off", "PDS Sync: not connected"],
			idle: ["check", "PDS Sync: synced"],
			syncing: ["refresh-cw", "PDS Sync: syncing…"],
			error: ["alert-triangle", "PDS Sync: errors - see console"],
		};
		const [icon, label] = map[state];
		this.statusBarEl.empty();
		setIcon(this.statusBarEl, icon);
		this.statusBarEl.setAttribute("aria-label", label);
	}

	private onVaultChange(file: TAbstractFile): void {
		if (!this.settings.autoSyncOnChange) return;
		if (!(file instanceof TFile) || file.extension !== "md") return;
		this.dirty.add(file.path);
		this.autoSyncDebounced?.();
	}

	/** Quietly push the notes changed since the last flush (status bar only). */
	private async flushAutoSync(): Promise<void> {
		if (!this.settings.autoSyncOnChange || this.dirty.size === 0) return;
		if (!(await this.ensureLogin(true))) {
			this.setStatus("off");
			return;
		}
		const paths = [...this.dirty];
		this.dirty.clear();
		this.setStatus("syncing");
		const outcome = emptyOutcome();
		const engine = this.engine();
		for (const p of paths) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile) await engine.syncFile(f, outcome);
		}
		this.setStatus(outcome.failed > 0 ? "error" : "idle");
		if (outcome.failed > 0)
			console.error("PDS auto-sync errors:", outcome.errors);
	}

	/** (Re)configure the periodic full-vault push. Call after the interval setting changes. */
	applyAutoSyncInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		const mins = this.settings.autoSyncIntervalMinutes;
		if (mins > 0) {
			this.intervalId = window.setInterval(
				() => void this.intervalSync(),
				mins * 60_000,
			);
			this.registerInterval(this.intervalId);
		}
	}

	private async intervalSync(): Promise<void> {
		if (!(await this.ensureLogin(true))) {
			this.setStatus("off");
			return;
		}
		this.setStatus("syncing");
		const outcome = await this.engine().syncVault();
		this.setStatus(outcome.failed > 0 ? "error" : "idle");
		if (outcome.failed > 0)
			console.error("PDS interval-sync errors:", outcome.errors);
	}

	/** Create or update the user's site.standard.publication and store its AT-URI. */
	async createPublication(): Promise<void> {
		if (!(await this.ensureLogin())) return;
		const s = this.settings;
		if (!s.publicationName.trim() || !s.publicationUrl.trim()) {
			new Notice(
				"PDS Sync: set a publication name and base URL in settings first.",
			);
			return;
		}
		const record: Record<string, unknown> = {
			$type: PUBLICATION_COLLECTION,
			name: s.publicationName.trim().slice(0, 5000),
			url: s.publicationUrl.trim().replace(/\/+$/, ""),
		};
		if (s.publicationDescription.trim())
			record.description = s.publicationDescription.trim();
		record.preferences = {
			$type: "site.standard.publication#preferences",
			showInDiscover: s.publicationShowInDiscover,
		};
		const theme = s.publicationThemeEnabled
			? buildBasicTheme(s.publicationTheme)
			: null;
		if (theme) record.basicTheme = theme;

		const iconPath = s.publicationIconPath.trim();
		if (iconPath) {
			const f = this.app.vault.getAbstractFileByPath(
				normalizePath(iconPath),
			);
			if (!(f instanceof TFile)) {
				new Notice(
					`PDS Sync: icon not found in vault: ${iconPath} (use a vault-relative path, e.g. assets/icon.png).`,
				);
				return;
			}
			const mime = mimeForExt(f.extension);
			if (!mime) {
				new Notice("PDS Sync: icon must be PNG, JPEG, WebP, or GIF.");
				return;
			}
			const bytes = await this.app.vault.readBinary(f);
			if (bytes.byteLength > 1_000_000) {
				new Notice("PDS Sync: icon must be under 1 MB.");
				return;
			}
			try {
				record.icon = await this.client.uploadBlob(bytes, mime);
			} catch (err) {
				new Notice(`PDS Sync: icon upload failed - ${msg(err)}`);
				return;
			}
		}

		try {
			const res = await this.client.putRecord(
				PUBLICATION_COLLECTION,
				s.publicationRkey || "self",
				record,
			);
			s.publicationUri = res.uri;
			await this.saveSettings();
			new Notice(
				`PDS Sync: publication saved - documents will use ${res.uri}`,
			);
			this.settingTab?.display();
		} catch (err) {
			new Notice(`PDS Sync: publication failed - ${msg(err)}`);
		}
	}

	/** Copy the AT-URI to host at <publicationUrl>/.well-known/site.standard.publication. */
	async copyVerification(): Promise<void> {
		const s = this.settings;
		if (!s.publicationUri) {
			new Notice("PDS Sync: create a publication first.");
			return;
		}
		await navigator.clipboard.writeText(s.publicationUri);
		const base =
			s.publicationUrl.trim().replace(/\/+$/, "") || "<your-site>";
		new Notice(
			`Copied AT-URI. Host it at ${base}/.well-known/site.standard.publication`,
		);
	}

	async runPull(): Promise<void> {
		if (!(await this.ensureLogin())) return;
		new Notice("PDS Sync: pulling…");
		const o = await this.engine().pull();
		const tail = `${o.restored} restored, ${o.updated} updated, ${o.deleted} deleted, ${o.conflicts} conflicts`;
		if (o.failed > 0) {
			console.error("PDS Sync pull errors:", o.errors);
			new Notice(
				`Pull: ${tail}, ${o.failed} failed.\n${o.errors[0] ?? ""}`,
			);
		} else {
			new Notice(`Pull: ${tail}, ${o.skipped} unchanged.`);
		}
	}

	async runSyncFile(file: TFile): Promise<void> {
		if (!(await this.ensureLogin())) return;
		const outcome: SyncOutcome = {
			created: 0,
			updated: 0,
			deleted: 0,
			conflicts: 0,
			skipped: 0,
			failed: 0,
			errors: [],
		};
		await this.engine().syncFile(file, outcome);
		this.notify(outcome, file.basename);
	}

	private async deleteRemoteRecord(idx: SyncIndex): Promise<void> {
		if (!this.client.isLoggedIn) {
			console.warn(
				`[pds-sync] note deleted while offline; remote record orphaned: ${idx.ref.rkey}`,
			);
			return;
		}
		try {
			await this.buildTargets()
				.get(idx.target)
				?.delete(this.client, idx.ref);
			new Notice("PDS Sync: removed deleted note from PDS.");
		} catch (err) {
			console.warn("[pds-sync] failed to delete remote record:", err);
		}
	}

	private notify(o: SyncOutcome, label?: string): void {
		const head = label ? `PDS Sync (${label})` : "PDS Sync";
		const tail = `${o.created} new, ${o.updated} updated, ${o.deleted} deleted, ${o.conflicts} conflicts`;
		if (o.failed > 0) {
			console.error("PDS Sync errors:", o.errors);
			new Notice(
				`${head}: ${tail}, ${o.failed} failed.\n${o.errors[0] ?? ""}`,
			);
		} else if (o.created + o.updated + o.deleted + o.conflicts === 0) {
			new Notice(`${head}: up to date (${o.skipped} unchanged).`);
		} else {
			new Notice(`${head}: ${tail}, ${o.skipped} unchanged.`);
		}
	}
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function emptyOutcome(): SyncOutcome {
	return {
		created: 0,
		updated: 0,
		deleted: 0,
		conflicts: 0,
		skipped: 0,
		failed: 0,
		errors: [],
	};
}

function mimeForExt(ext: string): string | null {
	switch (ext.toLowerCase()) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return null;
	}
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Build a site.standard.theme.basic value, or null unless all four colours are valid hex. */
function buildBasicTheme(
	t: PdsSyncSettings["publicationTheme"],
): Record<string, unknown> | null {
	const bg = hexToRgb(t.background);
	const fg = hexToRgb(t.foreground);
	const accent = hexToRgb(t.accent);
	const accentFg = hexToRgb(t.accentForeground);
	if (!bg || !fg || !accent || !accentFg) return null;
	const rgb = (c: { r: number; g: number; b: number }) => ({
		$type: "site.standard.theme.color#rgb",
		...c,
	});
	return {
		$type: "site.standard.theme.basic",
		background: rgb(bg),
		foreground: rgb(fg),
		accent: rgb(accent),
		accentForeground: rgb(accentFg),
	};
}

function secretDesc(app: App): string {
	return keychainAvailable(app)
		? "Stored in your OS keychain."
		: "Stored in data.json (no keychain on this Obsidian version).";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Open a URL in the system browser (works on desktop and mobile). */
function openExternal(url: string): void {
	if (Platform.isDesktopApp) {
		try {
			const electron = (
				window as unknown as { require?: (m: string) => unknown }
			).require?.("electron") as
				| { shell?: { openExternal?: (u: string) => void } }
				| undefined;
			if (electron?.shell?.openExternal) {
				electron.shell.openExternal(url);
				return;
			}
		} catch {
			/* fall through to window.open */
		}
	}
	window.open(url, "_blank");
}

class PdsSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: PdsSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("Auth mode")
			.setDesc(
				"OAuth (granular scopes, recommended) or app password (universal fallback).",
			)
			.addDropdown((d) =>
				d
					.addOption("oauth", "OAuth")
					.addOption("app-password", "App password")
					.setValue(s.authMode)
					.onChange(async (v) => {
						s.authMode = v as PdsSyncSettings["authMode"];
						await this.plugin.saveSettings();
						this.plugin.client.detach();
						this.display();
					}),
			);

		new Setting(containerEl).setName("Handle or DID").addText((t) =>
			t
				.setPlaceholder("you.bsky.social")
				.setValue(s.identifier)
				.onChange(async (v) => {
					s.identifier = v.trim();
					await this.plugin.saveSettings();
				}),
		);

		if (s.authMode === "app-password") {
			new Setting(containerEl)
				.setName("PDS service URL")
				.setDesc("e.g. https://bsky.social or a self-hosted PDS.")
				.addText((t) =>
					t.setValue(s.service).onChange(async (v) => {
						s.service = v.trim();
						await this.plugin.saveSettings();
					}),
				);
			new Setting(containerEl)
				.setName("App password")
				.setDesc(
					`Create one at bsky.app -> Settings -> App Passwords. ${secretDesc(this.app)}`,
				)
				.addText((t) => {
					t.inputEl.type = "password";
					t.setValue(
						readSecret(this.app, SECRET_APP_PASSWORD, s.appPassword),
					).onChange(async (v) => {
						const val = v.trim();
						s.appPassword = writeSecret(
							this.app,
							SECRET_APP_PASSWORD,
							val,
						)
							? ""
							: val;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName("Connect")
			.setDesc(
				this.plugin.client.isLoggedIn
					? `Connected: ${this.plugin.client.handle ?? this.plugin.client.did}`
					: "Not connected.",
			)
			.addButton((b) =>
				b
					.setButtonText("Connect")
					.setCta()
					.onClick(async () => {
						await this.plugin.connect();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Sync behaviour")
			.setDesc(
				"Opt-in per note: checkbox property 'pds' -> private (encrypted), 'publish' -> public (standard.site).",
			)
			.setHeading();

		new Setting(containerEl)
			.setName("Sync folder (optional)")
			.setDesc(
				"Restrict syncing to this vault folder. Empty = whole vault.",
			)
			.addText((t) =>
				t
					.setPlaceholder("e.g. Published")
					.setValue(s.syncFolder)
					.onChange(async (v) => {
						s.syncFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-sync on change")
			.setDesc(
				"Push edited notes automatically (debounced). Pull stays manual.",
			)
			.addToggle((t) =>
				t.setValue(s.autoSyncOnChange).onChange(async (v) => {
					s.autoSyncOnChange = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("Push the whole vault on a timer. 0 = off.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 120, 5)
					.setValue(s.autoSyncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.autoSyncIntervalMinutes = v;
						await this.plugin.saveSettings();
						this.plugin.applyAutoSyncInterval();
					}),
			);

		new Setting(containerEl)
			.setName("Private (E2E-encrypted)")
			.setHeading();

		new Setting(containerEl)
			.setName("Encryption passphrase")
			.setDesc(
				`Derives your AES-256 key (Argon2id). Lose it = lose access. ${secretDesc(this.app)}`,
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(
					readSecret(
						this.app,
						SECRET_E2EE_PASSPHRASE,
						s.e2eePassphrase,
					),
				).onChange(async (v) => {
					s.e2eePassphrase = writeSecret(
						this.app,
						SECRET_E2EE_PASSPHRASE,
						v,
					)
						? ""
						: v;
					await this.plugin.saveSettings();
					await this.plugin.deriveE2eeKey();
				});
			});

		new Setting(containerEl).setName("Public (standard.site)").setHeading();

		new Setting(containerEl).setName("Publication name").addText((t) =>
			t
				.setPlaceholder("My Notes")
				.setValue(s.publicationName)
				.onChange(async (v) => {
					s.publicationName = v;
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl)
			.setName("Publication base URL")
			.setDesc(
				"Where the publication lives on the web (combined with each document's path).",
			)
			.addText((t) =>
				t
					.setPlaceholder("https://moshyfawn.dev")
					.setValue(s.publicationUrl)
					.onChange(async (v) => {
						s.publicationUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Publication description (optional)")
			.addText((t) =>
				t.setValue(s.publicationDescription).onChange(async (v) => {
					s.publicationDescription = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Publication icon (optional)")
			.setDesc(
				"Vault path to a PNG/JPEG/WebP/GIF under 1 MB; uploaded on Create / update.",
			)
			.addText((t) =>
				t
					.setPlaceholder("assets/icon.png")
					.setValue(s.publicationIconPath)
					.onChange(async (v) => {
						s.publicationIconPath = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show in discovery feeds")
			.addToggle((t) =>
				t.setValue(s.publicationShowInDiscover).onChange(async (v) => {
					s.publicationShowInDiscover = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Custom theme")
			.setDesc("Send publication colours readers can use.")
			.addToggle((t) =>
				t.setValue(s.publicationThemeEnabled).onChange(async (v) => {
					s.publicationThemeEnabled = v;
					await this.plugin.saveSettings();
					renderThemeColors();
				}),
			);
		// Color rows live in their own container so toggling only re-renders them,
		// preserving the settings pane's scroll position.
		const themeColors = containerEl.createDiv();
		const renderThemeColors = () => {
			themeColors.empty();
			if (!s.publicationThemeEnabled) return;
			const theme = s.publicationTheme;
			const colorRow = (label: string, key: keyof typeof theme) =>
				new Setting(themeColors).setName(label).addColorPicker((c) =>
					c.setValue(theme[key]).onChange(async (v) => {
						theme[key] = v;
						await this.plugin.saveSettings();
					}),
				);
			colorRow("Background", "background");
			colorRow("Foreground", "foreground");
			colorRow("Accent", "accent");
			colorRow("Accent foreground", "accentForeground");
		};
		renderThemeColors();

		new Setting(containerEl)
			.setName("Create / update publication")
			.setDesc(
				"Writes a site.standard.publication record (with theme/discover) and fills the URI below.",
			)
			.addButton((b) =>
				b
					.setButtonText("Create / update")
					.setCta()
					.onClick(async () => {
						await this.plugin.createPublication();
					}),
			);

		new Setting(containerEl)
			.setName("Domain verification")
			.setDesc(
				"Copy the AT-URI to host at <base URL>/.well-known/site.standard.publication.",
			)
			.addButton((b) =>
				b
					.setButtonText("Copy .well-known")
					.onClick(() => void this.plugin.copyVerification()),
			);

		new Setting(containerEl)
			.setName("Publication URI")
			.setDesc(
				"Filled by the helper, or set manually (at:// or https://) to use an existing publication.",
			)
			.addText((t) =>
				t.setValue(s.publicationUri).onChange(async (v) => {
					s.publicationUri = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Advanced").setHeading();

		if (s.authMode === "oauth") {
			new Setting(containerEl)
				.setName("Client metadata URL")
				.setDesc(
					"Public HTTPS URL serving client-metadata.json (hosted on Tangled).",
				)
				.addText((t) =>
					t.setValue(s.oauthClientId).onChange(async (v) => {
						s.oauthClientId = v.trim();
						await this.plugin.saveSettings();
					}),
				);
			new Setting(containerEl)
				.setName("Redirect URL")
				.setDesc(
					"Same origin as the client metadata; bounces back to obsidian://.",
				)
				.addText((t) =>
					t.setValue(s.oauthRedirectUri).onChange(async (v) => {
						s.oauthRedirectUri = v.trim();
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Private collection (NSID)")
			.setDesc(
				"Changing this requires updating the OAuth scope + client metadata.",
			)
			.addText((t) =>
				t.setValue(s.privateCollection).onChange(async (v) => {
					s.privateCollection = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Public collection (NSID)")
			.setDesc(
				"Changing this requires updating the OAuth scope + client metadata.",
			)
			.addText((t) =>
				t.setValue(s.publicCollection).onChange(async (v) => {
					s.publicCollection = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Help & feedback")
			.setDesc("Documentation, issues, and source.")
			.addButton((b) =>
				b
					.setButtonText("Open repository")
					.onClick(() =>
						openExternal(
							"https://tangled.org/moshyfawn.dev/obsidian-pds-sync",
						),
					),
			);
	}
}
