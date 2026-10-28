/** 풀이 시간 표시: 12:34, 1:02:03 */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const hh = h ? `${h}:` : '';
  return `${hh}${mm}:${String(s).padStart(2, '0')}`;
}
