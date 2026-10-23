import { createHash, randomBytes } from 'node:crypto';
import type { GoogleProfile } from '../db.ts';

/** Google OAuth 2.0 (Authorization Code + PKCE). 서버가 code를 토큰으로 바꾸고 사용자 정보를 읽는다. */
export class GoogleAuthError extends Error {}

export type GoogleClient = {
  authUrl(params: { state: string; challenge: string; redirectUri: string }): string;
  exchange(params: { code: string; verifier: string; redirectUri: string }): Promise<GoogleProfile>;
};

export const newVerifier = () => randomBytes(32).toString('base64url');
export const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function googleClient(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): GoogleClient {
  return {
    authUrl({ state, challenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },

    async exchange({ code, verifier, redirectUri }) {
      const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const token = (await tokenRes.json().catch(() => null)) as { access_token?: string; error?: string } | null;
      if (!tokenRes.ok || !token?.access_token) throw new GoogleAuthError(`토큰 교환 실패 (${tokenRes.status} ${token?.error ?? ''})`);

      const infoRes = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const info = (await infoRes.json().catch(() => null)) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      } | null;
      if (!infoRes.ok || !info?.sub || !info.email) throw new GoogleAuthError(`사용자 정보 조회 실패 (${infoRes.status})`);
      if (info.email_verified !== true) throw new GoogleAuthError('이메일이 인증되지 않은 Google 계정입니다.');
      return { sub: info.sub, email: info.email.toLowerCase(), name: info.name ?? '', picture: info.picture ?? '' };
    },
  };
}
