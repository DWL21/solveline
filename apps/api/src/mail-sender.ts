// 메일 발송 서비스 경계. 서비스를 바꿀 때(Resend → Cloudflare Email) 이 파일의 구현만 바꾼다.

export type OutgoingMail = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
};

/** 발송 실패. retryable이면 다음 실행에서 다시 보낸다 */
export class MailSendError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export interface MailSender {
  /** 한 번에 최대 100통. 같은 key로 다시 부르면 중복 발송하지 않는다. 입력과 같은 순서로 발송 id를 돌려준다 */
  sendBatch(mails: OutgoingMail[], key: string): Promise<string[]>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** 메시지에 값이 섞이지 않게 상태 코드로만 오류를 남긴다 */
const failure = (status: number) => new MailSendError(`Resend 응답 ${status}`, status === 429 || status >= 500);

export class ResendSender implements MailSender {
  constructor(
    private apiKey: string,
    private fetcher: Fetch = (url, init) => fetch(url, init),
  ) {}

  async sendBatch(mails: OutgoingMail[], key: string): Promise<string[]> {
    const res = await this.fetcher('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(mails),
    });
    if (!res.ok) throw failure(res.status);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((d) => d.id);
  }
}
