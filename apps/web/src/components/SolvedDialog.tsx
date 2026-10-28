import { useEffect } from 'react';
import { formatDuration } from '../lib/time.ts';
import { Icon } from './Icon.tsx';

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
    // 바깥(어두운 배경)을 누르거나 Esc를 누르면 닫힌다. 안쪽을 누르면 닫히지 않는다.
    // 배경 클릭은 뒤에 깐 버튼이 받는다(키보드로는 Esc·닫기 버튼을 쓰므로 탭 순서와 읽기 대상에서 뺀다).
    <dialog
      open
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 h-auto max-h-none w-auto max-w-none text-inherit"
      aria-modal="true"
      aria-labelledby="solved-title"
    >
      <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-xl border border-line bg-panel px-6 pt-8 pb-6 text-center shadow-2xl">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-ok/15 text-ok" aria-hidden>
          <Icon name="check" size={24} strokeWidth={2.2} />
        </span>
        <p id="solved-title" className="mt-4 text-[20px] font-bold">
          정답입니다
        </p>
        {solvedMs !== null && (
          <p className="mt-2 text-[13px] text-dim">
            풀이 시간 <b className="font-mono text-text tabular-nums">{formatDuration(solvedMs)}</b>
          </p>
        )}
        {!onNext && <p className="mt-1 text-[13px] text-faint">이 목록의 마지막 문제예요.</p>}
        <div className="mt-6 flex flex-col gap-2">
          {onNext ? (
            <button type="button" className="btn-primary min-h-11 text-[15px]" onClick={onNext} autoFocus>
              다음 문제
            </button>
          ) : (
            <button type="button" className="btn-primary min-h-11 text-[15px]" onClick={onList} autoFocus>
              문제 목록으로
            </button>
          )}
          <button type="button" className="btn-quiet min-h-11" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </dialog>
  );
}
