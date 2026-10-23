import type { EditorHandle } from './CodeEditor.tsx';

/** 휴대폰 키보드에 없거나 찾기 번거로운 키. 왼쪽부터 자주 쓰는 순서. */
const SYMBOLS = ['(', ')', '{', '}', '[', ']', ';', '=', '<', '>', '+', '-', '*', '/', '%', '!', '&', '|', '"', "'", ',', '.', ':', '_', '?', '#', '\\'];

/**
 * 모바일 코딩 키 막대: 화상 키보드 바로 위에 붙는다.
 * 버튼을 눌러도 에디터 초점이 빠지지 않도록 pointerdown 기본 동작을 막는다(키보드가 내려가지 않게).
 */
export function CodeKeys({ editor }: { editor: { current: EditorHandle | null } }) {
  const keep = (e: React.PointerEvent) => e.preventDefault();
  const key = (label: string, onPress: () => void, aria?: string, wide = false) => (
    <button
      key={aria ?? label}
      type="button"
      aria-label={aria ?? label}
      onPointerDown={keep}
      onClick={onPress}
      className={`h-9 shrink-0 rounded-md bg-raised font-mono text-[15px] text-text active:bg-line-strong ${wide ? 'px-3 text-[13px] font-sans font-semibold' : 'min-w-9 px-2'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line bg-base px-2 py-1.5" role="toolbar" aria-label="코딩 키">
      {key('Tab', () => editor.current?.tab(), '들여쓰기', true)}
      {key('⇤', () => editor.current?.outdent(), '내어쓰기')}
      {key('↶', () => editor.current?.undo(), '실행 취소')}
      {key('↷', () => editor.current?.redo(), '다시 실행')}
      {key('←', () => editor.current?.left(), '커서 왼쪽')}
      {key('→', () => editor.current?.right(), '커서 오른쪽')}
      <span className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />
      {SYMBOLS.map((s) => key(s, () => editor.current?.insert(s), s === '\\' ? '역슬래시' : undefined))}
    </div>
  );
}
