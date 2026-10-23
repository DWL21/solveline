<p align="center">
  <b>Solveline</b> — 기존와 같은 Java·Python 코딩 테스트 연습 환경
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Java-OpenJDK%2021-e76f00" alt="OpenJDK 21">
  <img src="https://img.shields.io/badge/Python-3.13-3776ab" alt="Python 3.13">
  <img src="https://img.shields.io/badge/login-Google-4285f4" alt="Google login">
</p>

---

**서비스**: <a href="https://solveline.simplyimg.com">https://solveline.simplyimg.com</a>


---

기존 코딩 테스트 화면처럼 문제 설명·코드 에디터·실행 결과를 한 화면에 두고, 같은 계열의 Java·Python 환경에서 코드를 실행하는 웹 IDE입니다.
누구나 문제를 둘러볼 수 있고, Google 계정으로 가입하면 코드를 작성·실행·채점하고 풀이 기록을 남길 수 있습니다.

주요 특징:

* **solution 함수형**: `class Solution { ... solution(...) }` / `def solution(...)`을 테스트 케이스마다 호출하고 반환값을 기댓값과 타입까지 비교. `[1, 2]`, `"abc"`, `[["a", 1]]`처럼 기존 표기 그대로 입력.
* **표준 입출력형**: PCCE·입출력 문제처럼 `main`/스크립트를 입력과 함께 실행하고 출력 비교.
* **코드 실행 / 제출 후 채점**: 코드 실행은 보이는 케이스로 입력·기댓값·출력까지, 제출은 히든 케이스로 통과/실패·시간·메모리와 점수만 보여 준다(기존와 같음).
* **공용 문제집**: 문제·폴더·채점 케이스는 모두가 같이 본다. 편집 권한이 있는 사용자만 편집 모드에서 바꾸고, 바꾸면 모두에게 적용된다.
* **내 풀이 기록**: 작성 코드·내 테스트 케이스·메모·풀이 시간·채점 결과·컬렉션(가상 묶음)은 계정마다 따로 저장된다.
* **실시간 저장**: 언어별 코드·내 케이스·메모를 입력 즉시(0.3초) 저장하고, 문제 전환·탭 닫기 때도 바로 저장.
* **격리 실행**: 사용자 코드는 인터넷이 차단된 runner 컨테이너에서 권한을 낮춘 uid로 실행.
* **Google 로그인**: 로그인과 회원가입 모두 Google 계정. 처음이면 약관 동의(만 14세 이상·이용약관·개인정보 수집·이용) 화면을 거친다.
* **관리자 모드**(`/admin`): 마스터 비밀번호로만 연다. 사용자 목록·상세 현황을 보고, 편집 권한을 주거나 회수하고, 이용 정지·블랙리스트(이메일)·사용자 삭제를 관리한다.
* **실행 환경**: Java(OpenJDK 21.0.2), Python 3.13.13.

## 문서

| 문서 | 내용 |
|---|---|
| [개발 가이드](docs/development.md) | 요구 사항, 설치, 환경 변수·비밀 정보, 로컬 실행, 스택, 작업 흐름 |
| [API](docs/api.md) | 엔드포인트 목록, 접근 권한 |
| [구조와 배포](docs/architecture.md) | 실행 환경, 배포 구조, 채점 흐름, 이름 이전 |
| [결정 기록](docs/decisions) | 샌드박스, 채점 파이프라인, 로그인·권한 등 |
| [로드맵](docs/roadmap.md) | 앞으로 할 일 |
| [AGENTS.md](AGENTS.md) | 작업 규칙(사람·에이전트 공통) |
