// Node(24)와 Workers에 모두 있는 WebCrypto만 쓴다(node:crypto·Buffer는 Worker에서 쓰지 않는다).

const bytesToBase64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const base64urlToBytes = (v: string) => {
  const s = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
};

/** 임의 바이트 n개를 base64url로(세션 ID·PKCE verifier) */
export const randomToken = (bytes = 32) => bytesToBase64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** 0 이상 max 미만의 정수(편향 없이) */
export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % max;
}

const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const sha256Hex = async (text: string) => Array.from(await digest(text), (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256Base64url = async (text: string) => bytesToBase64url(await digest(text));

/** 비밀번호를 상수 시간으로 비교한다. 길이가 달라도 시간이 새지 않도록 해시끼리 비교한다. */
export async function sameSecret(expected: string, given: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(expected), digest(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** JSON 값을 쿠키에 담을 base64url 문자열로 */
export const encodeJson = (v: unknown) => bytesToBase64url(new TextEncoder().encode(JSON.stringify(v)));
export function decodeJson<T>(v: string | false | undefined): T | null {
  if (!v) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64urlToBytes(v))) as T;
  } catch {
    return null;
  }
}
