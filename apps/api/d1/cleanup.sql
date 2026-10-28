-- D1 매일 정리(0007 4단계). pahidc api의 BackupJob이 하던 정리를 Worker 대신 백업 워크플로가 실행한다.
-- 시각은 D1(SQLite) 기준 지금. expires_at·reset_at은 밀리초, finished_at은 ISO 8601(toISOString) 문자열이다.
DELETE FROM sessions WHERE expires_at < CAST(strftime('%s', 'now') AS INTEGER) * 1000;
DELETE FROM rate_limits WHERE reset_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
DELETE FROM submissions WHERE status IN ('done', 'error', 'cancelled') AND finished_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days');
