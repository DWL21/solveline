// Jenkins 품질 파이프라인 — GitHub Actions(.github/workflows/quality.yml)와 같은 단계·같은 스크립트를 쓴다.
// 에이전트 요구 사항: Docker(compose v2), Node 24 + corepack(pnpm), Playwright 브라우저 의존성.
// 로컬 Jenkins(Docker)로 바로 돌려 보려면 ci/jenkins/README.md.
pipeline {
  agent any
  options {
    timestamps()
    timeout(time: 60, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30'))
    disableConcurrentBuilds()
  }
  parameters {
    booleanParam(name: 'RUN_SONAR', defaultValue: true, description: 'SonarQube 정적 분석·품질 게이트')
    booleanParam(name: 'RUN_E2E', defaultValue: true, description: 'Docker 테스트 환경 + Playwright API·UI 자동화')
    string(name: 'E2E_PROJECTS', defaultValue: 'api desktop-chromium desktop-webkit mobile-iphone mobile-pixel tablet-ipad', description: 'Playwright 프로젝트(공백 구분)')
  }
  environment {
    CI = 'true'
    // Jenkins가 컨테이너 안에서 돌면 호스트 Docker에 띄운 서비스를 이 이름으로 부른다(호스트에서 직접 돌면 localhost)
    SERVICE_HOST = "${env.SERVICE_HOST ?: 'localhost'}"
  }
  stages {
    stage('설치') {
      steps {
        sh 'corepack enable && pnpm install --frozen-lockfile'
      }
    }
    stage('빠른 검사') {
      parallel {
        stage('타입 검사') {
          steps { sh 'pnpm typecheck' }
        }
        stage('단위 테스트·커버리지') {
          steps { sh 'pnpm --filter @solveline/api test:coverage' }
          post {
            always { junit allowEmptyResults: true, testResults: 'apps/api/reports/junit.xml' }
          }
        }
      }
    }
    stage('정적 분석(SonarQube)') {
      when { expression { params.RUN_SONAR } }
      steps { sh 'scripts/sonar.sh' }
    }
    stage('테스트 환경(Docker)') {
      when { expression { params.RUN_E2E } }
      steps { sh 'scripts/test-env.sh up' }
    }
    stage('API·UI 자동화') {
      when { expression { params.RUN_E2E } }
      steps {
        sh '''
          cd e2e
          pnpm exec playwright install chromium webkit
          pnpm exec playwright test $(for p in ${E2E_PROJECTS}; do printf -- '--project=%s ' "$p"; done)
        '''
      }
      post {
        always { junit allowEmptyResults: true, testResults: 'e2e/reports/junit.xml' }
        failure { sh 'scripts/test-env.sh logs > e2e/reports/test-env.log || true' }
      }
    }
  }
  post {
    always {
      sh 'node scripts/quality-report.mjs || true'
      archiveArtifacts allowEmptyArchive: true, artifacts: 'reports/quality/**, e2e/reports/**, apps/api/coverage/**'
      sh 'scripts/test-env.sh down || true'
    }
  }
}
