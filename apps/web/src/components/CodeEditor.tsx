import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
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
import { cursorCharLeft, cursorCharRight, defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, undo } from '@codemirror/commands';
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
  foldGutter(),
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

/** 바깥(모바일 코딩 키 막대)에서 에디터를 다루는 손잡이 */
export type EditorHandle = {
  /** 커서 자리에 글자를 넣는다. 여는 괄호·따옴표는 짝을 함께 넣고 커서를 가운데 둔다. */
  insert: (text: string) => void;
  tab: () => void;
  outdent: () => void;
  undo: () => void;
  redo: () => void;
  left: () => void;
  right: () => void;
  focus: () => void;
};

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };

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
  handle,
  visible = true,
}: {
  readOnly?: boolean;
  /** 코딩 키 막대가 쓰는 손잡이 */
  handle?: { current: EditorHandle | null };
  /** 탭 전환으로 다시 보일 때 크기를 다시 잰다 */
  visible?: boolean;
  docKey: string;
  value: string;
  language: Language;
  onChange: (v: string) => void;
  onRun: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const cb = useRef({ onChange, onRun });
  cb.current = { onChange, onRun };

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
          EditorState.readOnly.of(readOnly),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          lang.current.of(langExt(language)),
          oneDark,
          navy,
          touchFriendly,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (handle) {
      const run = (cmd: (target: EditorView) => boolean) => () => {
        cmd(v);
        v.focus();
      };
      handle.current = {
        insert: (text) => {
          const close = PAIRS[text];
          const sel = v.state.selection.main;
          if (close && sel.empty) {
            v.dispatch({ changes: { from: sel.from, insert: text + close }, selection: { anchor: sel.from + text.length }, userEvent: 'input' });
          } else {
            v.dispatch({ ...v.state.replaceSelection(text), userEvent: 'input' });
          }
          v.focus();
        },
        // 선택이 없으면 커서 자리에 들여쓰기 단위(공백 4칸)를, 있으면 줄 들여쓰기. 탭 문자는 넣지 않는다(Python 혼용 오류 방지).
        tab: run((t) => {
          if (!t.state.selection.main.empty) return indentMore(t);
          t.dispatch({ ...t.state.replaceSelection(t.state.facet(indentUnit)), userEvent: 'input' });
          return true;
        }),
        outdent: run(indentLess),
        undo: run(undo),
        redo: run(redo),
        left: run(cursorCharLeft),
        right: run(cursorCharRight),
        focus: () => v.focus(),
      };
    }
    return () => {
      if (handle) handle.current = null;
      v.destroy();
    };
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

  return <div ref={host} className="code-editor h-full min-h-0 overflow-hidden" />;
}
