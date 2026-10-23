import { useEffect, useState, type CSSProperties } from 'react';

/** 원형 스피너. 색은 currentColor라 버튼 안에서도 글자색을 따른다. */
export function Spinner({ size = 16, className = '', label }: { size?: number; className?: string; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} aria-label={label} className={`inline-flex shrink-0 ${className}`}>
      <svg className="animate-spin motion-reduce:animate-[spin_2.4s_linear_infinite]" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** 내용 자리를 미리 보여 주는 회색 블록(반짝임) */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`skeleton block rounded-md ${className}`} style={style} />;
}

/** 짧은 로딩(기본 300ms 미만)에서는 아무것도 그리지 않아 깜빡임을 없앤다. */
function useDelayed(ms: number) {
  const [show, setShow] = useState(ms === 0);
  useEffect(() => {
    if (ms === 0) return;
    const t = setTimeout(() => setShow(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return show;
}

/** 앱 시작 화면: 로고 + 스피너 */
export function BootScreen() {
  const show = useDelayed(300);
  return (
    <div className="flex h-full items-center justify-center bg-ink" role="status" aria-label="Solveline을 여는 중">
      {show && (
        <div className="flex animate-[fadein_200ms_ease-out] flex-col items-center gap-4">
          <img src="/icon.svg" alt="" className="size-10" />
          <Spinner size={22} className="text-accent" />
        </div>
      )}
    </div>
  );
}

/** 문제 목록 스켈레톤 */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row" role="status" aria-label="목록을 불러오는 중">
      <div className="hidden w-60 shrink-0 flex-col gap-2 border-r border-line bg-base px-3 py-4 md:flex">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-7" style={{ width: `${70 + ((i * 13) % 25)}%` }} />
        ))}
      </div>
      <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
        <Skeleton className="mb-4 h-7 w-40" />
        <Skeleton className="mb-4 h-9 w-full sm:w-72" />
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
              <Skeleton className="h-4" style={{ width: `${45 + ((i * 17) % 35)}%` }} />
              <Skeleton className="ml-auto h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 문제 화면 스켈레톤: 왼쪽 설명, 오른쪽 에디터·결과 */
export function WorkspaceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-label="문제를 불러오는 중">
      <div className="flex items-center gap-3 border-b border-line bg-base px-4 py-2.5">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="ml-auto h-7 w-24" />
        <Skeleton className="h-7 w-20" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex flex-col gap-3 border-line bg-panel p-4 md:w-[40%] md:border-r">
          <Skeleton className="h-4 w-1/3" />
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-3.5" style={{ width: `${60 + ((i * 11) % 38)}%` }} />
          ))}
        </div>
        <div className="flex min-h-[300px] flex-1 flex-col gap-2.5 bg-raised p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-3.5 opacity-70" style={{ width: `${30 + ((i * 19) % 50)}%`, marginLeft: `${(i % 3) * 16}px` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 몇 줄짜리 작은 스켈레톤(패널 안) */
export function LinesSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2 py-2" role="status" aria-label="불러오는 중">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-8" style={{ width: `${88 - i * 9}%` }} />
      ))}
    </div>
  );
}
