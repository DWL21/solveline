#!/usr/bin/env bash
# D1 매일 암호화 백업(0007 4단계). .github/workflows/backup-d1.yml(GitHub-hosted, 일정 실행)이 실행한다.
#   1) wrangler d1 export로 SQL을 받는다
#   2) age 공개 키로 암호화한다(평문은 러너 임시 폴더에만 두고 바로 지운다. 비공개 키는 운영자만 오프라인에 둔다)
#   3) 비공개 R2 버킷(기본 solveline-backup, 수명 주기 7일)에 d1/solveline-YYYY-MM-DD.sql.age로 올린다
#   4) 백업이 끝난 뒤 매일 정리 SQL(apps/api/d1/cleanup.sql)을 실행한다
# 설정(CLOUDFLARE_API_TOKEN·CLOUDFLARE_ACCOUNT_ID·D1_DATABASE·BACKUP_AGE_RECIPIENT)이 하나라도 없으면 건너뛴다(5단계 전환 전).
# 값은 출력하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."

missing=()
for k in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID D1_DATABASE BACKUP_AGE_RECIPIENT; do
  [ -n "${!k:-}" ] || missing+=("$k")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "D1 백업 설정이 없어 건너뜁니다: ${missing[*]}"
  exit 0
fi

BUCKET=${BACKUP_BUCKET:-solveline-backup}
WRANGLER=(npx --yes wrangler@4.151.0)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
DAY=$(date -u +%F)
KEY="d1/solveline-$DAY.sql.age"

"${WRANGLER[@]}" d1 export "$D1_DATABASE" --remote --output "$WORK/d1.sql"
[ -s "$WORK/d1.sql" ] || { echo "내보낸 SQL이 비어 있습니다." >&2; exit 1; }
grep -q 'CREATE TABLE' "$WORK/d1.sql" || { echo "내보낸 SQL에 테이블이 없습니다." >&2; exit 1; }

age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/d1.sql.age" "$WORK/d1.sql"
rm -f "$WORK/d1.sql"

"${WRANGLER[@]}" r2 object put "$BUCKET/$KEY" --file "$WORK/d1.sql.age" --content-type application/octet-stream --remote
echo "백업: $BUCKET/$KEY ($(wc -c < "$WORK/d1.sql.age") bytes, 암호화)"

"${WRANGLER[@]}" d1 execute "$D1_DATABASE" --remote --file apps/api/d1/cleanup.sql --yes
echo "정리 SQL 실행: apps/api/d1/cleanup.sql"
