-- 임시 계정의 기본 폴더 지연 복사와 사용하지 않는 이전 제출 큐 색인 제거
ALTER TABLE users ADD COLUMN folders_initialized INTEGER NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS submissions_queue;
