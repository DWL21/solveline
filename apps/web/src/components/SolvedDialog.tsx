import { useEffect } from 'react';
import { formatDuration } from '../lib/time.ts';

/** 정답(100점) 직후 팝업: 다음 문제로 바로 넘어가거나, 닫고 계속 본다. */
export function SolvedDialog({
  solvedMs,
  onNext,
  onList,
  onClose,
}: Readonly<{
  solvedMs: number | null;
  /** 같은 목록의 다음 문제가 없으면 undefined */
  onNext?: () => void;
  onList: () => void;
  onClose: () => void;
}>) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    globalThis.addEventListener('keydown', h);
    return () => globalThis.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    // 바깥(어두운 배경)을 누르거나 Esc를 누르면 닫힌다. 안쪽을 누르면 닫히지 않는다(대상이 배경 자신일 때만 닫기).
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="solved-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="w-full max-w-sm rounded-xl border border-ok/40 bg-panel p-6 text-center shadow-2xl">
        <p id="solved-title" className="text-[20px] font-bold text-ok">
          ✓ 정답입니다!
        </p>
        {solvedMs !== null && (
          <p className="mt-2 text-[13px] text-dim">
            풀이 시간 <b className="font-mono text-text tabular-nums">{formatDuration(solvedMs)}</b>
          </p>
        )}
        {!onNext && <p className="mt-2 text-[12.5px] text-faint">이 목록의 마지막 문제예요.</p>}
        <div className="mt-5 flex flex-col gap-2">
          {onNext ? (
            <button type="button" className="btn-primary min-h-11 text-[15px]" onClick={onNext} autoFocus>
              다음 문제 →
            </button>
          ) : (
            <button type="button" className="btn-primary min-h-11 text-[15px]" onClick={onList} autoFocus>
              문제 목록으로
            </button>
          )}
          <button type="button" className="btn-quiet" onClick={onClose}>
            닫기 <span className="text-[11px] text-faint">(Esc)</span>
          </button>
        </div>
      </div>
    </div>
  );
}
