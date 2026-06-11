import { argon2id } from "hash-wasm";

/**
 * Client-side end-to-end encryption for private notes.
 *
 * The PDS (and firehose) only ever see opaque ciphertext. Because that
 * ciphertext currently lives in your public, permanently-archived repo, the
 * whole scheme's security rests on (a) passphrase entropy and (b) KDF cost -
 * so we use Argon2id (memory-hard) rather than PBKDF2.
 *
 * Key = Argon2id(passphrase, salt), where salt is derived deterministically
 * from your DID. A salt only needs to be unique per user, not secret, so a
 * DID-derived salt is as safe as a stored random one - and it's identical on
 * every device automatically (no record, no sync, no extra OAuth scope).
 *
 * Wire format (base64): [12-byte IV][AES-256-GCM ciphertext+tag].
 */

// OWASP-recommended Argon2id (m=46 MiB, t=1, p=1).
const ARGON2_MEMORY_KIB = 47104;
const ARGON2_ITERATIONS = 1;
const ARGON2_PARALLELISM = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Deterministic per-user salt: SHA-256 of a domain-separated DID. */
async function saltFromDid(did: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`pds-sync:${did}`),
	);
	return new Uint8Array(digest);
}

export async function deriveKey(
	passphrase: string,
	did: string,
): Promise<CryptoKey> {
	const raw = await argon2id({
		password: passphrase,
		salt: await saltFromDid(did),
		iterations: ARGON2_ITERATIONS,
		parallelism: ARGON2_PARALLELISM,
		memorySize: ARGON2_MEMORY_KIB,
		hashLength: KEY_BYTES,
		outputType: "binary",
	});
	return crypto.subtle.importKey(
		"raw",
		Uint8Array.from(raw),
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptJson(
	value: unknown,
	key: CryptoKey,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const plaintext = new TextEncoder().encode(JSON.stringify(value));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
	);
	const out = new Uint8Array(iv.length + ciphertext.length);
	out.set(iv, 0);
	out.set(ciphertext, iv.length);
	return bytesToBase64(out);
}

export async function decryptJson<T = unknown>(
	blob: string,
	key: CryptoKey,
): Promise<T> {
	const bytes = base64ToBytes(blob);
	const iv = bytes.slice(0, IV_BYTES);
	const ciphertext = bytes.slice(IV_BYTES);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		ciphertext,
	);
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
