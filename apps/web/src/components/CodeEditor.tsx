import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Language } from '@codetest/shared';

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

/** 문서 단위 에디터. docKey가 바뀌면(문제·언어 전환) 내용을 통째로 교체한다. */
export function CodeEditor({
  docKey,
  value,
  language,
  onChange,
  onRun,
}: {
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
            indentWithTab,
          ]),
          basicSetup,
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          lang.current.of(langExt(language)),
          oneDark,
          navy,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
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
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      effects: lang.current.reconfigure(langExt(language)),
    });
    // docKey가 바뀔 때만 외부 값을 밀어 넣는다 (타이핑 중 덮어쓰지 않게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
