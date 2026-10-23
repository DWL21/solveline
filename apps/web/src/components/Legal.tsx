import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PRIVACY_VERSION, TERMS_VERSION } from '@codetest/shared';
import { api, qk } from '../lib/api.ts';

/** 화면 맨 아래 약관 링크. admin이면 관리자 모드로 가는 흐린 글자를 덧붙인다. */
export function LegalFooter({ admin = false }: { admin?: boolean }) {
  return (
    <footer className="flex shrink-0 items-center justify-center gap-3 px-4 py-4 text-[11.5px] text-faint">
      <span>© Solveline</span>
      <a href="/terms" className="hover:text-dim">
        이용약관
      </a>
      <a href="/privacy" className="font-semibold hover:text-dim">
        개인정보처리방침
      </a>
      {admin && (
        <a href="/admin" className="text-faint/50 hover:text-faint">
          관리자 모드
        </a>
      )}
    </footer>
  );
}

function useContact() {
  const q = useQuery({ queryKey: qk.publicConfig, queryFn: api.publicConfig, staleTime: Infinity });
  return q.data?.contactEmail ?? null;
}

function Page({ title, version, children }: { title: string; version: string; children: ReactNode }) {
  return (
    <div className="min-h-full bg-ink">
      <header className="border-b border-line bg-[#0f1922]">
        <div className="mx-auto flex h-12 max-w-3xl items-center px-4">
          <a href="/" className="flex items-center gap-2">
            <img src="/icon.svg" alt="" className="size-6" />
            <span className="text-[15px] font-extrabold tracking-tight">Solveline</span>
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-[22px] font-extrabold">{title}</h1>
        <p className="mt-1 text-[12.5px] text-faint">시행일 {version}</p>
        <div className="legal mt-6 flex flex-col gap-6 text-[14px] leading-[1.8] text-text/90 [&_h2]:mb-2 [&_h2]:text-[15.5px] [&_h2]:font-bold [&_li]:ml-5 [&_ol]:list-decimal [&_table]:w-full [&_table]:text-[13px] [&_td]:border [&_td]:border-line [&_td]:p-2 [&_td]:align-top [&_th]:border [&_th]:border-line [&_th]:bg-panel [&_th]:p-2 [&_th]:text-left [&_ul]:list-disc">
          {children}
        </div>
      </main>
      <LegalFooter />
    </div>
  );
}

const Contact = ({ email }: { email: string | null }) => (email ? <a href={`mailto:${email}`} className="text-accent underline">{email}</a> : <span>서비스 내 안내된 연락처</span>);

export function TermsPage() {
  const email = useContact();
  return (
    <Page title="이용약관" version={TERMS_VERSION}>
      <section>
        <h2>제1조 (목적)</h2>
        <p>이 약관은 Solveline(이하 "서비스")의 이용 조건과 절차, 운영자와 회원의 권리·의무를 정합니다.</p>
      </section>
      <section>
        <h2>제2조 (정의)</h2>
        <ol>
          <li>"서비스"란 웹에서 코딩 테스트 문제를 풀고 Java·Python 코드를 실행·채점하는 서비스를 말합니다.</li>
          <li>"회원"이란 Google 계정으로 가입해 이 약관에 동의하고 서비스를 이용하는 사람을 말합니다.</li>
          <li>"운영자"란 서비스를 운영하는 개인을 말합니다.</li>
        </ol>
      </section>
      <section>
        <h2>제3조 (약관의 효력과 변경)</h2>
        <ol>
          <li>이 약관은 서비스 화면에 게시하고, 가입할 때 동의하면 효력이 생깁니다.</li>
          <li>운영자는 관련 법령을 어기지 않는 범위에서 약관을 바꿀 수 있으며, 바꾸면 시행일 7일 전(회원에게 불리한 변경은 30일 전)부터 서비스에 알립니다.</li>
          <li>바뀐 약관에 동의하지 않으면 탈퇴할 수 있습니다.</li>
        </ol>
      </section>
      <section>
        <h2>제4조 (회원가입)</h2>
        <ol>
          <li>만 14세 이상인 사람은 Google 계정으로 인증하고 이 약관과 개인정보 수집·이용에 동의해 가입할 수 있습니다.</li>
          <li>운영자는 다른 사람의 계정을 쓰거나, 이전에 이용이 제한된 경우 가입을 거절할 수 있습니다.</li>
        </ol>
      </section>
      <section>
        <h2>제5조 (서비스의 내용)</h2>
        <ol>
          <li>문제 열람, 코드 작성·자동 저장, 코드 실행과 채점, 풀이 시간·제출 기록·메모·내 테스트 케이스·컬렉션 저장을 제공합니다.</li>
          <li>서비스는 무료이며, 운영자는 운영상·기술상 필요에 따라 서비스의 전부 또는 일부를 바꾸거나 중단할 수 있습니다. 중단할 때는 가능한 한 미리 알립니다.</li>
          <li>코드 실행에는 시간·메모리·요청 횟수 제한이 있습니다.</li>
        </ol>
      </section>
      <section>
        <h2>제6조 (회원의 의무)</h2>
        <p>회원은 다음 행위를 해서는 안 됩니다.</p>
        <ul>
          <li>실행 환경(샌드박스)을 벗어나거나 서버·네트워크를 공격·탐색하는 코드를 실행하는 행위</li>
          <li>암호화폐 채굴, 과도한 자동 요청 등으로 서비스에 부담을 주는 행위</li>
          <li>다른 사람의 계정을 쓰거나 개인정보를 수집하는 행위</li>
          <li>법령이나 공공질서에 어긋나는 내용을 저장·실행하는 행위</li>
          <li>서비스의 문제·채점 데이터를 허락 없이 대량으로 복제·배포하는 행위</li>
        </ul>
      </section>
      <section>
        <h2>제7조 (게시물과 권리)</h2>
        <ol>
          <li>회원이 작성한 코드·메모·테스트 케이스의 권리는 회원에게 있습니다. 운영자는 서비스 제공(저장·실행·채점·백업)에 필요한 범위에서만 이를 이용합니다.</li>
          <li>서비스가 제공하는 문제와 채점 데이터의 권리는 운영자 또는 원저작자에게 있습니다.</li>
        </ol>
      </section>
      <section>
        <h2>제8조 (이용 제한)</h2>
        <p>운영자는 회원이 제6조를 어기면 사전 통지 없이 이용을 정지하거나 가입을 제한할 수 있습니다. 회원은 아래 연락처로 이의를 제기할 수 있습니다.</p>
      </section>
      <section>
        <h2>제9조 (탈퇴)</h2>
        <p>회원은 언제든지 서비스 화면의 "회원 탈퇴"로 탈퇴할 수 있으며, 탈퇴하면 회원의 작성 코드·메모·제출 기록 등은 바로 삭제되고 되돌릴 수 없습니다.</p>
      </section>
      <section>
        <h2>제10조 (책임의 제한)</h2>
        <ol>
          <li>운영자는 천재지변, 회원의 귀책, 외부 서비스(Google, Cloudflare 등)의 장애로 생긴 손해에 책임을 지지 않습니다.</li>
          <li>서비스는 학습용으로 제공되며, 채점 결과가 실제 코딩 테스트의 결과와 같음을 보장하지 않습니다.</li>
          <li>운영자는 고의 또는 중대한 과실이 없는 한, 무료로 제공하는 서비스 이용과 관련해 생긴 손해에 책임을 지지 않습니다.</li>
        </ol>
      </section>
      <section>
        <h2>제11조 (준거법과 분쟁)</h2>
        <p>이 약관은 대한민국 법을 따르며, 분쟁은 민사소송법상 관할 법원에서 해결합니다.</p>
      </section>
      <section>
        <h2>문의</h2>
        <p>
          <Contact email={email} />
        </p>
      </section>
    </Page>
  );
}

export function PrivacyPage() {
  const email = useContact();
  return (
    <Page title="개인정보처리방침" version={PRIVACY_VERSION}>
      <p>Solveline(이하 "서비스")은 「개인정보 보호법」에 따라 이용자의 개인정보를 보호하고, 관련 고충을 신속하게 처리하기 위해 다음과 같이 개인정보처리방침을 둡니다.</p>
      <section>
        <h2>1. 수집하는 개인정보와 목적</h2>
        <table>
          <thead>
            <tr>
              <th>구분</th>
              <th>항목</th>
              <th>목적</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>회원가입·로그인(필수)</td>
              <td>Google 계정 식별자, 이메일, 이름, 프로필 사진 URL, 약관 동의 일시·버전</td>
              <td>회원 식별, 로그인 유지, 부정 이용 방지</td>
            </tr>
            <tr>
              <td>서비스 이용 중 생성</td>
              <td>작성 코드, 내 테스트 케이스, 메모, 제출·채점 기록, 풀이 시간, 컬렉션</td>
              <td>코드 실행·채점, 풀이 기록 저장</td>
            </tr>
            <tr>
              <td>자동 수집</td>
              <td>접속 IP, 접속 일시, 브라우저 정보, 세션 쿠키</td>
              <td>보안, 요청 횟수 제한, 장애 대응</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2">Google 계정의 비밀번호는 받지 않습니다. 만 14세 미만 아동의 가입은 받지 않습니다.</p>
      </section>
      <section>
        <h2>2. 보유·이용 기간과 파기</h2>
        <ul>
          <li>회원 정보와 서비스 이용 기록: 회원 탈퇴 시 지체 없이 삭제합니다.</li>
          <li>장애 대비 백업: 최대 7일 보관 후 자동 삭제합니다.</li>
          <li>접속 기록(서버 로그): 서비스마다 30MB를 넘으면 오래된 것부터 자동 삭제합니다.</li>
          <li>이용 제한 기록(차단 이메일): 부정 재가입 방지를 위해 제한을 해제할 때까지 보관합니다.</li>
        </ul>
        <p className="mt-2">전자 파일은 복구할 수 없는 방법으로 삭제합니다.</p>
      </section>
      <section>
        <h2>3. 제3자 제공</h2>
        <p>이용자의 개인정보를 제3자에게 제공하지 않습니다. 다만 법령에 따라 수사기관 등이 요구하는 경우는 예외로 합니다.</p>
      </section>
      <section>
        <h2>4. 처리 위탁과 국외 이전</h2>
        <table>
          <thead>
            <tr>
              <th>받는 자(국가)</th>
              <th>업무</th>
              <th>항목</th>
              <th>보유 기간</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Google LLC (미국)</td>
              <td>Google 계정 로그인 인증</td>
              <td>로그인 시 Google이 처리하는 계정 정보</td>
              <td>Google 정책에 따름</td>
            </tr>
            <tr>
              <td>Cloudflare, Inc. (미국)</td>
              <td>웹 트래픽 전달, 보안</td>
              <td>접속 IP, 요청 정보</td>
              <td>전송 처리 동안</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2">서비스 데이터는 대한민국에 있는 서버에 저장합니다. 국외 이전은 서비스 이용 시 네트워크를 통해 이루어지며, 이전을 원하지 않으면 탈퇴할 수 있습니다.</p>
      </section>
      <section>
        <h2>5. 쿠키</h2>
        <p>로그인 상태를 유지하기 위해 세션 쿠키를 씁니다. 브라우저 설정으로 쿠키를 거부할 수 있지만, 그러면 로그인할 수 없습니다. 광고·분석용 쿠키는 쓰지 않습니다.</p>
      </section>
      <section>
        <h2>6. 이용자의 권리</h2>
        <p>
          이용자는 언제든지 자신의 개인정보 열람·정정·삭제·처리정지를 요구할 수 있습니다. 서비스 화면의 "회원 탈퇴"로 바로 삭제할 수 있고, 그 밖의 요청은 아래 연락처로 하면 지체 없이
          처리합니다.
        </p>
      </section>
      <section>
        <h2>7. 안전성 확보 조치</h2>
        <ul>
          <li>전 구간 HTTPS 암호화, 서명된 세션 쿠키(HttpOnly·Secure)</li>
          <li>사용자 코드는 격리된 실행 환경에서 네트워크 없이 실행</li>
          <li>비밀 값은 접근이 제한된 저장소에만 보관하고 로그에 남기지 않음</li>
        </ul>
      </section>
      <section>
        <h2>8. 개인정보 보호책임자</h2>
        <p>
          운영자 · <Contact email={email} />
        </p>
        <p className="mt-2 text-[13px] text-dim">
          개인정보 침해 신고·상담: 개인정보침해신고센터(privacy.kisa.or.kr, 국번 없이 118), 개인정보분쟁조정위원회(kopico.go.kr, 1833-6972)
        </p>
      </section>
      <section>
        <h2>9. 변경</h2>
        <p>이 방침을 바꾸면 시행일 7일 전부터 서비스에 알립니다.</p>
      </section>
    </Page>
  );
}
