// 로그·에러 메시지에서 비밀 값을 지운다.
const secrets = new Set<string>();

/** 비밀 값을 등록하면 이후 redact()가 해당 문자열을 가린다. */
export function registerSecret(value: string | null | undefined) {
  if (value && value.length >= 6) secrets.add(value);
}

export function mask(value: string) {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export function redact(text: string) {
  let out = text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/("?(?:access_token|client_secret|clientSecret|token|secret|password)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1***')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***jwt***');
  for (const s of secrets) out = out.split(s).join(mask(s));
  return out;
}

export const log = {
  info: (msg: string) => console.log(redact(msg)),
  warn: (msg: string) => console.warn(redact(msg)),
  error: (msg: string, err?: unknown) =>
    console.error(redact(err === undefined ? msg : `${msg}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)),
};
