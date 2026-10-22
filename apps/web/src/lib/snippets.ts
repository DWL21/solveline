import { completeFromList, snippet, snippetCompletion, type Completion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

/**
 * IntelliJ식 Java 코드 템플릿. 약어를 치고 Tab을 누르면 펼쳐지고, ${…} 자리는 Tab으로 차례로 옮겨 다닌다.
 * 자동 완성 목록에도 같은 템플릿이 뜬다.
 */
const JAVA_TEMPLATES: { abbr: string; detail: string; template: string }[] = [
  { abbr: 'sout', detail: 'System.out.println()', template: 'System.out.println(${});' },
  { abbr: 'soutv', detail: 'System.out.println("x = " + x)', template: 'System.out.println("${x} = " + ${x});' },
  { abbr: 'souf', detail: 'System.out.printf()', template: 'System.out.printf("${}%n"${});' },
  { abbr: 'serr', detail: 'System.err.println()', template: 'System.err.println(${});' },
  { abbr: 'fori', detail: 'for (int i = 0; i < n; i++)', template: 'for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}' },
  { abbr: 'iter', detail: 'for (T x : items)', template: 'for (${int} ${x} : ${items}) {\n\t${}\n}' },
  { abbr: 'psvm', detail: 'public static void main', template: 'public static void main(String[] args) {\n\t${}\n}' },
];

const byAbbr = new Map(JAVA_TEMPLATES.map((t) => [t.abbr, snippet(t.template)]));

export const javaTemplateCompletions = completeFromList(
  JAVA_TEMPLATES.map((t): Completion => snippetCompletion(t.template, { label: t.abbr, detail: t.detail, type: 'keyword', boost: 50 })),
);

/** 커서 바로 앞 단어가 템플릿 약어면 펼친다(Tab 키). 아니면 false를 돌려 원래 Tab 동작(들여쓰기)으로 넘긴다. */
export function expandJavaTemplate(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  const before = line.text.slice(0, sel.head - line.from);
  const m = /(?:^|[^\w.])([a-z]+)$/.exec(before);
  const apply = m && byAbbr.get(m[1]!);
  if (!apply || !m) return false;
  const from = sel.head - m[1]!.length;
  apply(view, { label: m[1]! }, from, sel.head);
  return true;
}
