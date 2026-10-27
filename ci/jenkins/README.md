# 로컬 Jenkins

[`Jenkinsfile`](../../Jenkinsfile)을 실제 Jenkins로 돌려 본다. Jenkins 설정(관리자·작업)은 코드(JCasC, [`casc.yaml`](casc.yaml))로 만든다.

```console
$ ci/jenkins/run.sh            # 지금 브랜치로 'solveline-quality' 작업 실행, 결과를 기다린다
$ ci/jenkins/run.sh main       # 브랜치 지정
$ ci/jenkins/run.sh down       # 내리기(작업 기록은 ~/.solveline-jenkins에 남는다)
```

- 화면: http://localhost:8099 (계정 `admin`, 비밀번호는 처음 실행 때 만든 `ci/jenkins/.env.local`)
- Jenkins는 호스트 Docker를 소켓으로 쓴다(Docker-outside-of-Docker). 작업 공간을 호스트와 **같은 경로**로 마운트해, 파이프라인 안의 `docker run -v "$PWD:…"`도 호스트에서 맞는 경로가 된다.
- 파이프라인이 띄운 테스트 환경·SonarQube는 호스트에 있으므로 `SERVICE_HOST=host.docker.internal`로 부른다(JCasC 전역 환경 변수).
- 저장소는 읽기 전용(`/repo`)으로 마운트해 로컬 커밋을 그대로 가져온다. 커밋하지 않은 변경은 빌드에 들어가지 않는다.

회사 Jenkins에 붙일 때는 같은 `Jenkinsfile`을 "Pipeline script from SCM"으로 지정하고, 에이전트에 Docker·Node 24·Playwright 의존성만 있으면 된다. SonarQube 서버가 따로 있다면 `scripts/sonar.sh` 대신 `withSonarQubeEnv` + `waitForQualityGate`로 바꿔 끼운다.
