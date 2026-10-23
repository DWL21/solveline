import { useEffect, useRef, useState } from 'react';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Language } from '@solveline/shared';

const navy = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--color-raised)' },
    '.cm-gutters': { backgroundColor: 'var(--color-raised)', borderRight: '1px solid var(--color-line)', color: 'var(--color-faint)' },
    '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgb(255 255 255 / 0.06)' },
  },
  { dark: true },
);

const langExt = (l: Language) => (l === 'java' ? java() : python());

/**
 * 기존 에디터에 가깝게: 자동 완성 목록·코드 템플릿 없음(실력 향상 목적), Tab은 들여쓰기만.
 * codemirror의 basicSetup에서 autocompletion만 뺀 구성이다.
 */
const editorSetup: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
];

/** 휴대폰 키보드의 자동 대문자·자동 수정·맞춤법 검사를 끈다(코드가 바뀌지 않게). */
const touchFriendly: Extension = [
  EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', 'aria-label': '코드 에디터' }),
];

/**
 * 줄바꿈된 줄의 이어지는 부분을 그 줄의 들여쓰기보다 2칸 더 들여 보여 준다(어느 블록인지 한눈에 보이게).
 * 첫 줄은 그대로 두고(text-indent 음수 + padding), 화면에 보이는 줄만 계산한다.
 */
const wrapIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const marks = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          const lead = /^[ \t]*/.exec(line.text)![0].replace(/\t/g, '    ').length;
          const hang = lead + 2;
          marks.push(Decoration.line({ attributes: { style: `padding-left: calc(${hang}ch + 6px); text-indent: -${hang}ch` } }).range(line.from));
          pos = line.to + 1;
        }
      }
      return Decoration.set(marks);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * 좁은 화면(휴대폰): 긴 줄은 줄바꿈해 가로 스크롤 없이 읽고, 접기 여백을 빼서 코드 폭을 넓힌다.
 * 넓은 화면: 줄바꿈 없이 접기 여백을 둔다(기존 데스크톱과 같게).
 */
const layoutFor = (compact: boolean): Extension =>
  compact
    ? [
        EditorView.lineWrapping,
        wrapIndent,
        EditorView.theme({
          '.cm-gutters': { paddingLeft: '2px' },
          '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 4px', minWidth: '24px' },
          '.cm-content': { paddingBottom: '40vh' },
        }),
      ]
    : foldGutter();

/** 바깥 값으로 문서를 바꾼 트랜잭션. 사용자의 편집이 아니므로 onChange를 부르지 않는다. */
const external = Annotation.define<boolean>();

/** 문서 단위 에디터. docKey가 바뀌면(문제·언어 전환) 내용을 통째로 교체한다. */
export function CodeEditor({
  docKey,
  value,
  language,
  onChange,
  onRun,
  readOnly = false,
  visible = true,
  compact = false,
  onFocusChange,
}: {
  /** 에디터에 초점이 들어오고 나갈 때(휴대폰에서는 화상 키보드가 열리고 닫힐 때) */
  onFocusChange?: (focused: boolean) => void;
  readOnly?: boolean;
  /** 탭 전환으로 다시 보일 때 크기를 다시 잰다 */
  visible?: boolean;
  /** 좁은 화면 배치(줄바꿈, 접기 여백 없음) */
  compact?: boolean;
  docKey: string;
  value: string;
  language: Language;
  onChange: (v: string) => void;
  onRun: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const layout = useRef(new Compartment());
  const cb = useRef({ onChange, onRun, onFocusChange });
  cb.current = { onChange, onRun, onFocusChange };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([
            { key: 'Mod-Enter', preventDefault: true, run: () => (cb.current.onRun(), true) },
          ]),
          editorSetup,
          layout.current.of(layoutFor(compact)),
          EditorState.readOnly.of(readOnly),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          lang.current.of(langExt(language)),
          oneDark,
          navy,
          touchFriendly,
          EditorView.updateListener.of((u) => {
            if (u.focusChanged) cb.current.onFocusChange?.(u.view.hasFocus);
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // 최초 1회만 만든다. 이후 변경은 아래 effect가 반영한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const same = v.state.doc.toString() === value;
    v.dispatch({
      changes: same ? undefined : { from: 0, to: v.state.doc.length, insert: value },
      effects: lang.current.reconfigure(langExt(language)),
      annotations: external.of(true),
    });
    // docKey가 바뀔 때만 외부 값을 밀어 넣는다 (타이핑 중 덮어쓰지 않게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    if (visible) view.current?.requestMeasure();
  }, [visible]);

  useEffect(() => {
    view.current?.dispatch({ effects: layout.current.reconfigure(layoutFor(compact)) });
  }, [compact]);

  // 좁은 화면: 두 손가락으로 벌리고 오므려 글자 크기 조절(이 기기에 기억)
  const [fontPx, setFontPx] = useState(() => {
    try {
      return Number(localStorage.getItem(FONT_KEY)) || 0;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    const el = host.current;
    if (!el || !compact) return;
    let start: { dist: number; font: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const current = () => parseFloat(getComputedStyle(el.querySelector('.cm-content') ?? el).fontSize) || 13;
    const clampFont = (v: number) => Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, v)));
    // iOS(Safari·Chrome)는 두 손가락 동작을 화면 확대 제스처로 먼저 가져간다 → 제스처 이벤트로 받아 코드 글자에만 적용한다.
    // 키보드가 열려 있든 닫혀 있든 같게 동작한다.
    if ('ongesturestart' in window) {
      let base = 0;
      const gStart = (e: Event) => {
        e.preventDefault();
        base = current();
      };
      const gChange = (e: Event) => {
        e.preventDefault();
        if (base) setFontPx(clampFont(base * (e as Event & { scale: number }).scale));
      };
      const gEnd = (e: Event) => {
        e.preventDefault();
        base = 0;
      };
      el.addEventListener('gesturestart', gStart, { passive: false });
      el.addEventListener('gesturechange', gChange, { passive: false });
      el.addEventListener('gestureend', gEnd, { passive: false });
      return () => {
        el.removeEventListener('gesturestart', gStart);
        el.removeEventListener('gesturechange', gChange);
        el.removeEventListener('gestureend', gEnd);
      };
    }
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) start = { dist: dist(e.touches), font: current() };
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault(); // 화면 전체 확대 대신 코드 글자만 키운다
      setFontPx(clampFont((start.font * dist(e.touches)) / start.dist));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [compact]);
  useEffect(() => {
    if (!fontPx) return;
    try {
      localStorage.setItem(FONT_KEY, String(fontPx));
    } catch {
      /* 저장소를 쓸 수 없는 환경 */
    }
    view.current?.requestMeasure();
  }, [fontPx]);

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={host}
        className="code-editor h-full min-h-0 overflow-hidden"
        style={compact && fontPx ? ({ '--code-font': `${fontPx}px` } as React.CSSProperties) : undefined}
      />
      {compact && <FastScroll view={view} />}
    </div>
  );
}

// v2: 기본 글자를 13px로 줄이면서 예전에 저장한 크기는 쓰지 않는다
const FONT_KEY = 'solveline.codeFont.v2';
const MIN_FONT = 9;
const MAX_FONT = 22;

/**
 * 긴 코드를 빨리 오가는 손잡이(오른쪽 가장자리). 스크롤하면 잠깐 나타나고, 끌면 그 위치로 바로 이동한다.
 * 휴대폰에서는 브라우저 스크롤바가 보이지 않고 끌 수도 없어서 따로 둔다.
 */
function FastScroll({ view }: { view: { current: EditorView | null } }) {
  const [pos, setPos] = useState({ top: 0, size: 1, show: false });
  const dragging = useRef<{ startY: number; startTop: number } | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let scroller: HTMLElement | null = null;
    const measure = () => {
      if (!scroller) return;
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      const size = clientHeight / scrollHeight;
      setPos((p) => ({ top: scrollHeight > clientHeight ? scrollTop / (scrollHeight - clientHeight) : 0, size, show: p.show }));
    };
    const onScroll = () => {
      measure();
      setPos((p) => ({ ...p, show: true }));
      if (hide.current) clearTimeout(hide.current);
      hide.current = setTimeout(() => !dragging.current && setPos((p) => ({ ...p, show: false })), 1200);
    };
    // 에디터가 만들어진 뒤에 붙는다
    const attach = () => {
      scroller = view.current?.scrollDOM ?? null;
      if (!scroller) return void (raf = requestAnimationFrame(attach));
      scroller.addEventListener('scroll', onScroll, { passive: true });
      measure();
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      scroller?.removeEventListener('scroll', onScroll);
      if (hide.current) clearTimeout(hide.current);
    };
  }, [view]);

  // 코드가 한 화면에 다 들어오면 손잡이가 필요 없다
  if (pos.size >= 0.8) return null;
  const thumbPct = Math.max(12, pos.size * 100);
  const move = (clientY: number) => {
    const s = view.current?.scrollDOM;
    const t = track.current;
    if (!s || !t || !dragging.current) return;
    const range = t.clientHeight * (1 - thumbPct / 100);
    const ratio = Math.min(1, Math.max(0, dragging.current.startTop + (clientY - dragging.current.startY) / range));
    s.scrollTop = ratio * (s.scrollHeight - s.clientHeight);
  };
  return (
    <div ref={track} className="pointer-events-none absolute top-1 right-0 bottom-1 w-7" aria-hidden>
      <div
        className={`pointer-events-auto absolute right-1 w-1.5 touch-none rounded-full bg-dim/70 transition-opacity duration-300 ${pos.show || dragging.current ? 'opacity-100' : 'opacity-0'}`}
        style={{ top: `${pos.top * (100 - thumbPct)}%`, height: `${thumbPct}%` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = { startY: e.clientY, startTop: pos.top };
          setPos((p) => ({ ...p, show: true }));
        }}
        onPointerMove={(e) => move(e.clientY)}
        onPointerUp={() => {
          dragging.current = null;
          setPos((p) => ({ ...p, show: false }));
        }}
      >
        {/* 손가락으로 잡기 쉽게 보이지 않는 넓은 영역 */}
        <span className="absolute -inset-x-3 -inset-y-2" />
      </div>
    </div>
  );
}
