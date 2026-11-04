-- D1 쓰기 줄이기(#225). db-node.ts의 lazyFoldersMigration과 같게 유지한다(테스트가 비교한다).
-- 기본 폴더(틀) 복사를 가입 때가 아니라 폴더·배치를 처음 바꿀 때 한다. 이미 있는 사용자는 복사를 마쳤다.
ALTER TABLE users ADD COLUMN folders_copied INTEGER NOT NULL DEFAULT 0;
UPDATE users SET folders_copied = 1;
-- 제출 대기열은 judge로 옮겼다. 이 색인은 쓰는 쿼리 없이 제출 저장·상태 변경마다 쓰기만 늘린다.
DROP INDEX submissions_queue;
