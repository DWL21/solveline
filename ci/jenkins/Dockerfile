# 로컬에서 Jenkins 파이프라인을 그대로 돌려 보기 위한 Jenkins 컨트롤러(단일 노드).
# Docker는 호스트의 것을 쓰고(소켓 공유), 작업 공간은 호스트와 같은 경로로 마운트해 docker -v 경로가 맞게 한다.
FROM jenkins/jenkins:2.528.1-lts-jdk21
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssl python3 \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin nodejs \
  && corepack enable \
  && npx -y playwright@1.64.1 install-deps chromium webkit \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt
COPY casc.yaml /usr/share/jenkins/ref/casc.yaml
# 로컬 저장소(file:///repo)를 그대로 가져오도록 허용(이 로컬 전용 Jenkins에서만)
ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/ref/casc.yaml JAVA_OPTS="-Djenkins.install.runSetupWizard=false -Dhudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT=true"
