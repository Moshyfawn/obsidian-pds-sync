import { Client } from "@atcute/client";
import { PasswordSession } from "@atcute/password-session";
import {
	configureOAuth,
	createAuthorizationUrl,
	finalizeAuthorization,
	getSession,
	OAuthUserAgent,
} from "@atcute/oauth-browser-client";
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";

/**
 * Auth strategies, both producing an authenticated @atcute/client `Client`.
 *
 * - App password: PasswordSession (works everywhere; legacy but simple). Tokens
 *   live in memory only - we re-login from the keychain'd password each launch
 *   rather than persisting JWTs to disk.
 * - OAuth: the no-backend public-client flow (PKCE + DPoP-bound PAR), with the
 *   atproto-mandated HTTPS redirect bouncing back into Obsidian via obsidian://.
 *
 */

export interface AuthResult {
	rpc: Client;
	did: string;
	handle?: string;
}

// Resolve handle -> DID without an appview: DNS-over-HTTPS (CORS-friendly for Electron env) raced
// against the handle domain's /.well-known/atproto-did. DID docs resolve via PLC/web.
const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Idempotent - safe to call repeatedly. */
export function setupOAuth(clientId: string, redirectUri: string): void {
	configureOAuth({
		metadata: { client_id: clientId, redirect_uri: redirectUri },
		identityResolver: new LocalActorResolver({
			handleResolver: new CompositeHandleResolver({
				strategy: "race",
				methods: {
					dns: new DohJsonHandleResolver({ dohUrl: DOH_URL }),
					http: new WellKnownHandleResolver(),
				},
			}),
			didDocumentResolver: new CompositeDidDocumentResolver({
				methods: {
					plc: new PlcDidDocumentResolver(),
					web: new WebDidDocumentResolver(),
				},
			}),
		}),
	});
}

export async function startOAuthLogin(
	identifier: string,
	scope: string,
): Promise<URL> {
	return createAuthorizationUrl({
		target: { type: "account", identifier: identifier as never },
		scope,
	});
}

export async function finishOAuthLogin(
	params: URLSearchParams,
): Promise<AuthResult> {
	const { session } = await finalizeAuthorization(params);
	const agent = new OAuthUserAgent(session);
	return { rpc: new Client({ handler: agent }), did: agent.sub };
}

export async function resumeOAuth(did: string): Promise<AuthResult> {
	const session = await getSession(did as never, { allowStale: true });
	const agent = new OAuthUserAgent(session);
	return { rpc: new Client({ handler: agent }), did: agent.sub };
}

export async function loginPassword(creds: {
	service: string;
	identifier: string;
	password: string;
}): Promise<AuthResult> {
	const session = await PasswordSession.login(creds);
	return {
		rpc: new Client({ handler: session }),
		did: session.did,
		handle: session.session.handle,
	};
}
