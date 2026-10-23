# 코드 실행 환경. 기존와 같은 계열의 버전을 빌드 인자로 고정한다.
ARG PYTHON_VERSION=3.13.13
ARG JAVA_VERSION=21.0.2_13
FROM eclipse-temurin:${JAVA_VERSION}-jdk AS jdk

FROM python:${PYTHON_VERSION}-slim-bookworm
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=$JAVA_HOME/bin:$PATH
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
# 사용자 코드는 이 uid로만 실행된다 (서버 프로세스는 root, 필요한 capability만 유지)
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin sandbox
WORKDIR /opt/runner
COPY runner/server.py runner/py_harness.py runner/selftest.py ./
COPY runner/java/SolvelineHarness.java java/
RUN javac -encoding UTF-8 -d java java/SolvelineHarness.java && rm java/SolvelineHarness.java \
  && python3 -m compileall -q /opt/runner && chmod -R a+rX,go-w /opt/runner
ENV HARNESS_DIR=/opt/runner JAVA_HARNESS_CP=/opt/runner/java SANDBOX_UID=10001 WORK_ROOT=/tmp PORT=8000 \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4)" || exit 1
CMD ["python3", "/opt/runner/server.py"]
