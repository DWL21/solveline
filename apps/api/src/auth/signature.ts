import { createPublicKey, verify, type KeyObject } from 'node:crypto';

const B64URL = /^[A-Za-z0-9_-]+$/;

/** `pnpm keygen`이 출력한 base64url 32바이트 raw 공개키를 KeyObject로 만든다. */
export function parsePublicKey(rawB64url: string): KeyObject {
  if (!B64URL.test(rawB64url) || Buffer.from(rawB64url, 'base64url').length !== 32) {
    throw new Error('ACCESS_PUBLIC_KEY는 base64url 32바이트 Ed25519 공개키여야 합니다.');
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawB64url }, format: 'jwk' });
}

/** Ed25519 서명(base64url 64바이트)을 검증한다. 형식이 틀리면 false. */
export function verifySignature(publicKey: KeyObject, message: string, signatureB64url: string): boolean {
  if (!B64URL.test(signatureB64url)) return false;
  const sig = Buffer.from(signatureB64url, 'base64url');
  if (sig.length !== 64) return false;
  try {
    return verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
  } catch {
    return false;
  }
}
