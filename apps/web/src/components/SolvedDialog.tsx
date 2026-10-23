import { useEffect } from 'react';
import { formatDuration } from '../lib/time.ts';

/** 정답(100점) 직후 팝업: 다음 문제로 바로 넘어가거나, 닫고 계속 본다. */
export function SolvedDialog({
  solvedMs,
  onNext,
  onList,
  onClose,
}: {
  solvedMs: number | null;
  /** 같은 목록의 다음 문제가 없으면 undefined */
  onNext?: () => void;
  onList: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="solved-title" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-ok/40 bg-panel p-6 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
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
