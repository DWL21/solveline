import { AwsClient } from 'aws4fetch';

/** 카탈로그·테스트셋을 올리는 객체 저장소(R2). 테스트에서는 MemoryObjectStore를 쓴다. */
export interface ObjectStore {
  put(key: string, body: string | Uint8Array, meta: { contentType: string }): Promise<void>;
  /** 없으면 null */
  get(key: string): Promise<Uint8Array | null>;
  /** prefix로 시작하는 키 전부 */
  list(prefix: string): Promise<string[]>;
}

export class ObjectStoreError extends Error {}

/** Cloudflare R2(S3 호환 API). 키·비밀은 로그에 남기지 않는다. */
export class R2ObjectStore implements ObjectStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(opts: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.client = new AwsClient({ accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, service: 's3', region: 'auto' });
    this.base = `https://${opts.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(opts.bucket)}`;
  }

  private url(key: string) {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, body: string | Uint8Array, meta: { contentType: string }) {
    const headers: Record<string, string> = { 'content-type': meta.contentType };
    // Uint8Array는 BodyInit 타입 정의에 없어 Buffer로 감싼다(런타임은 같다)
    const res = await this.client.fetch(this.url(key), { method: 'PUT', body: typeof body === 'string' ? body : Buffer.from(body), headers });
    if (!res.ok) throw new ObjectStoreError(`R2에 ${key}를 올리지 못했습니다 (${res.status})`);
  }

  async get(key: string) {
    const res = await this.client.fetch(this.url(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new ObjectStoreError(`R2에서 ${key}를 읽지 못했습니다 (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix });
      if (token) q.set('continuation-token', token);
      const res = await this.client.fetch(`${this.base}?${q}`);
      if (!res.ok) throw new ObjectStoreError(`R2 목록을 읽지 못했습니다 (${res.status})`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(unescapeXml(m[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null) : null;
    } while (token);
    return keys;
  }
}

/**
 * Pages Worker의 R2 바인딩을 거쳐 쓰는 저장소(서버에 R2 API 키를 두지 않는다).
 * Worker의 /api/internal/r2 경로가 공유 비밀(R2_PROXY_SECRET)을 확인하고 catalog/·testsets/ 아래만 읽고 쓴다.
 */
export class WorkerR2Store implements ObjectStore {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  private send(path: string, init: RequestInit = {}) {
    return this.fetchImpl(`${this.baseUrl}/api/internal/r2${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(120_000) });
  }

  private static path(key: string) {
    return `/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, body: string | Uint8Array, meta: { contentType: string }) {
    const res = await this.send(WorkerR2Store.path(key), { method: 'PUT', body: typeof body === 'string' ? body : Buffer.from(body), headers: { 'content-type': meta.contentType } });
    if (!res.ok) throw new ObjectStoreError(`R2에 ${key}를 올리지 못했습니다 (${res.status})`);
  }

  async get(key: string) {
    const res = await this.send(WorkerR2Store.path(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new ObjectStoreError(`R2에서 ${key}를 읽지 못했습니다 (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async list(prefix: string) {
    const res = await this.send(`?list=${encodeURIComponent(prefix)}`);
    if (!res.ok) throw new ObjectStoreError(`R2 목록을 읽지 못했습니다 (${res.status})`);
    return ((await res.json()) as { keys: string[] }).keys;
  }
}

const unescapeXml = (s: string) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

/** 테스트용 */
export class MemoryObjectStore implements ObjectStore {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();
  puts = 0;

  async put(key: string, body: string | Uint8Array, meta: { contentType: string }) {
    this.puts++;
    this.objects.set(key, { body: typeof body === 'string' ? new TextEncoder().encode(body) : body, ...meta });
  }

  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }

  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
}
