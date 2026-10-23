import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

type Layout = { leftPct: number; editorPct: number };
const KEY = 'solveline.layout.v1';
/** 예전 이름(codetest) 시절의 키. 새 키가 없을 때만 읽는다. */
const LEGACY_KEY = 'codetest.layout.v1';
export const DEFAULT_LAYOUT: Layout = { leftPct: 40, editorPct: 60 };
export const LIMITS = { leftPct: [20, 75], editorPct: [15, 85] } as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** 창 크기(%)를 이 브라우저에 기억한다. 저장소를 못 쓰면 기본값으로 동작. */
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY) ?? 'null') as Partial<Layout> | null;
      return {
        leftPct: clamp(Number(v?.leftPct) || DEFAULT_LAYOUT.leftPct, LIMITS.leftPct),
        editorPct: clamp(Number(v?.editorPct) || DEFAULT_LAYOUT.editorPct, LIMITS.editorPct),
      };
    } catch {
      return DEFAULT_LAYOUT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      /* 저장소를 쓸 수 없는 환경 */
    }
  }, [layout]);
  const set = useCallback((key: keyof Layout, v: number) => setLayout((l) => ({ ...l, [key]: clamp(v, LIMITS[key]) })), []);
  return { layout, set };
}

/**
 * 끌어서 크기를 바꾸는 경계. container 안에서 포인터 위치를 %로 바꿔 onChange에 넘긴다.
 * 더블클릭하면 기본값, 포커스 후 방향키로 2%씩 조절.
 */
export function Splitter({
  direction,
  container,
  value,
  defaultValue,
  label,
  onChange,
}: {
  direction: 'vertical' | 'horizontal';
  container: RefObject<HTMLElement | null>;
  value: number;
  defaultValue: number;
  label: string;
  onChange: (pct: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const vertical = direction === 'vertical';

  const toPct = (e: PointerEvent) => {
    const r = container.current?.getBoundingClientRect();
    if (!r) return value;
    return vertical ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) onChange(toPct(e));
  };
  const stop = () => setDragging(false);

  // 끄는 동안 글자가 선택되거나 커서가 바뀌지 않게
  useEffect(() => {
    if (!dragging) return;
    const prev = [document.body.style.userSelect, document.body.style.cursor];
    document.body.style.userSelect = 'none';
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    return () => {
      [document.body.style.userSelect, document.body.style.cursor] = prev as [string, string];
    };
  }, [dragging, vertical]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[e.key];
    if (step === undefined) return;
    if (vertical !== (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    e.preventDefault();
    onChange(value + step);
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={`${label} — 끌어서 크기 조절, 더블클릭하면 기본값`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={onKeyDown}
      className={`group relative z-10 hidden shrink-0 outline-none md:block ${vertical ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'} ${
        dragging ? 'bg-accent' : 'bg-line hover:bg-accent/70 focus-visible:bg-accent'
      }`}
    />
  );
}
