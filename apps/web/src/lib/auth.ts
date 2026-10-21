import { AUTH_MESSAGE_PREFIX } from '@codetest/shared';
import { api } from './api.ts';

/**
 * 개인키 로그인.
 * - 키 파일 내용은 이 탭 메모리에서만 다루고 서버로 보내거나 저장하지 않는다.
 * - "기억하기"를 고르면 내보낼 수 없는(non-extractable) CryptoKey 객체만 IndexedDB에 둔다.
 */

export class KeyError extends Error {}

const ED25519 = { name: 'Ed25519' } as const;

/** 브라우저가 WebCrypto Ed25519 서명을 지원하는지 확인 */
export async function ed25519Supported(): Promise<boolean> {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) return false;
  try {
    await crypto.subtle.generateKey(ED25519, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (!m?.[1]) {
    if (/BEGIN (ENCRYPTED|OPENSSH|EC|RSA) PRIVATE KEY/.test(pem)) throw new KeyError('지원하지 않는 키 형식이에요. pnpm keygen으로 만든 키를 쓰세요.');
    throw new KeyError('PEM 개인키 파일이 아니에요');
  }
  let bin: string;
  try {
    bin = atob(m[1].replace(/\s+/g, ''));
  } catch {
    throw new KeyError('키 파일이 손상됐어요');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PEM 텍스트 → 서명 전용, 내보내기 불가 CryptoKey */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  try {
    return await crypto.subtle.importKey('pkcs8', der, ED25519, false, ['sign']);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotSupportedError') throw new KeyError('이 브라우저는 Ed25519 서명을 지원하지 않아요');
    throw new KeyError('Ed25519 개인키가 아니에요');
  } finally {
    der.fill(0);
  }
}

function base64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** challenge → 서명 → verify. 성공하면 서버가 세션 쿠키를 심는다. */
export async function signIn(key: CryptoKey) {
  const { nonce } = await api.challenge();
  const message = new TextEncoder().encode(AUTH_MESSAGE_PREFIX + nonce);
  const signature = await crypto.subtle.sign(ED25519, key, message);
  return api.verify(nonce, base64url(signature));
}

// ─── 기억한 키 (IndexedDB, CryptoKey 객체 그대로 저장) ───

const DB = 'codetest-auth';
const STORE = 'keys';
const ID = 'access';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const rememberedKey = {
  async load(): Promise<CryptoKey | null> {
    try {
      const v: unknown = await tx('readonly', (s) => s.get(ID));
      return v instanceof CryptoKey ? v : null;
    } catch {
      return null;
    }
  },
  async save(key: CryptoKey): Promise<boolean> {
    try {
      await tx('readwrite', (s) => s.put(key, ID));
      return true;
    } catch {
      return false;
    }
  },
  async clear(): Promise<void> {
    try {
      await tx('readwrite', (s) => s.delete(ID));
    } catch {
      /* 저장소를 쓸 수 없는 환경 */
    }
  },
};
