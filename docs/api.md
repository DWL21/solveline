# API

전체 스키마는 [`packages/shared/src/index.ts`](../packages/shared/src/index.ts)에 있습니다. 문제·폴더 조회(GET)는 비회원도 되고, 나머지는 로그인 세션이 필요합니다. 문제·폴더·히든 케이스를 바꾸는 요청은 편집 권한이 있어야 합니다.

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/api/auth/google/start` | Google 로그인 시작(로그인·회원가입 공통) |
| `GET` | `/api/auth/google/callback` | Google 인증 결과. 기존 회원은 로그인, 새 계정은 `/signup`으로 |
| `GET` `POST` | `/api/auth/signup` | 가입 대기 중인 Google 계정 / 약관 동의 후 가입 |
| `GET` | `/api/auth/session` | 세션 상태와 로그인한 계정(편집 권한 포함) |
| `POST` | `/api/auth/logout` | 로그아웃 |
| `GET` | `/api/public/config` | 공개 설정(문의 이메일, 약관 버전) |
| `POST` | `/api/admin/login` | 관리자 모드(마스터 비밀번호) |
| `GET` | `/api/admin/users`, `/api/admin/users/{id}` | 사용자 목록 / 상세 현황 |
| `PUT` | `/api/admin/users/{id}/role`, `/api/admin/users/{id}/block` | 편집 권한 주기·회수 / 이용 정지·해제 |
| `DELETE` | `/api/admin/users/{id}` | 사용자 삭제(풀이 기록 모두 삭제) |
| `GET` `POST` `DELETE` | `/api/admin/blocklist` | 블랙리스트(이메일) |
| `GET` | `/api/runtime` | runner 상태와 Java·Python 버전 |
| `GET` `POST` | `/api/problems` | 문제 목록 / 만들기 |
| `GET` `PUT` `DELETE` | `/api/problems/{id}` | 문제 조회 / 저장 / 삭제 |
| `GET` `POST` | `/api/folders` | 폴더 목록 / 만들기 |
| `PUT` `DELETE` | `/api/folders/{id}` | 폴더 이름 바꾸기 / 삭제 (문제는 폴더 없음으로) |
| `GET` `POST` | `/api/collections` | 컬렉션 목록(문제 id 순서 포함) / 만들기 |
| `PUT` `DELETE` | `/api/collections/{id}` | 컬렉션 이름·설명 바꾸기 / 삭제 (문제는 그대로) |
| `PUT` | `/api/collections/{id}/items` | 컬렉션의 문제 목록·순서 지정 |
| `GET` `PUT` | `/api/problems/{id}/hidden` | 히든 테스트셋 읽기 / 바꾸기 (내용 해시 파일로 저장) |
| `POST` | `/api/submissions` | 코드 실행(`run`) 또는 제출 채점(`submit`)을 대기열에 넣고 id 반환 (202) |
| `GET` | `/api/submissions/{id}` | 제출 상태(queued·running·done·error), 대기 순번, 결과·점수 |
| `POST` | `/api/run` | 동기 실행(스크립트용, 내부적으로 대기열 사용) |
| `GET` | `/api/health` | 상태 확인 |
