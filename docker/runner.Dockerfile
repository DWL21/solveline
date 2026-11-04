# 코드 실행 환경. 기존와 같은 계열의 버전을 빌드 인자로 고정한다.
ARG PYTHON_VERSION=3.13.13
ARG JAVA_VERSION=21.0.2_13
FROM eclipse-temurin:${JAVA_VERSION}-jdk AS jdk

FROM python:${PYTHON_VERSION}-slim-bookworm
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=$JAVA_HOME/bin:$PATH
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
# 사용자 코드는 실행 슬롯마다 다른 uid로 실행된다(10002~, 슬롯 수만큼). 10001은 기동 기준값 측정용.
# 서버 프로세스는 root, 필요한 capability만 유지한다.
# 10000은 예열 컴파일 서버(javac만 돌린다, 사용자 코드를 실행하지 않는다).
RUN useradd --uid 10000 --no-create-home --shell /usr/sbin/nologin compiler \
  && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin sandbox \
  && for i in $(seq 1 16); do useradd --uid $((10001 + i)) --no-create-home --shell /usr/sbin/nologin "sandbox$i"; done
WORKDIR /opt/runner
COPY runner/server.py runner/seccomp_filter.py runner/py_harness.py runner/selftest.py runner/health.py ./
COPY runner/java/SolvelineHarness.java java/
COPY runner/java/SolvelineCompiler.java compiler/
RUN javac -encoding UTF-8 -d java java/SolvelineHarness.java && rm java/SolvelineHarness.java \
  && javac -encoding UTF-8 -d compiler compiler/SolvelineCompiler.java && rm compiler/SolvelineCompiler.java \
  && python3 -m compileall -q /opt/runner && chmod -R a+rX,go-w /opt/runner
ENV HARNESS_DIR=/opt/runner JAVA_HARNESS_CP=/opt/runner/java COMPILER_UID=10000 SANDBOX_UID=10001 WORK_ROOT=/tmp PORT=8000 \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD python3 /opt/runner/health.py || exit 1
CMD ["python3", "/opt/runner/server.py"]
