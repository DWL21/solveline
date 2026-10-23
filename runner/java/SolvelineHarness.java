import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Java 함수형 문제 실행기: Solution 클래스의 solution(...)을 한 번 호출한다.
 * 인자는 case.json(JSON)에서 매개변수 타입에 맞게 변환하고, 반환값은 result.json에 기록한다.
 * 사용자 System.out 출력은 그대로 stdout으로 나간다.
 */
public final class SolvelineHarness {
    public static void main(String[] argv) throws Exception {
        Path work = Path.of(argv[0]);
        Path result = work.resolve("result.json");
        Object caseJson = new Json(Files.readString(work.resolve("case.json"), StandardCharsets.UTF_8)).parse();
        List<?> args = (List<?>) ((Map<?, ?>) caseJson).get("args");
        try {
            Class<?> cls = Class.forName("Solution");
            Method m = findSolution(cls, args.size());
            if (m == null) {
                write(result, "{\"ok\":false,\"error\":" + quote("Solution 클래스에 매개변수 " + args.size() + "개인 solution 메서드가 없습니다.") + "}");
                return;
            }
            m.setAccessible(true);
            Type[] types = m.getGenericParameterTypes();
            Object[] values = new Object[types.length];
            for (int i = 0; i < types.length; i++) values[i] = convert(args.get(i), types[i], "매개변수 " + (i + 1));
            Object target = null;
            if (!Modifier.isStatic(m.getModifiers())) {
                Constructor<?> c = cls.getDeclaredConstructor();
                c.setAccessible(true);
                target = c.newInstance();
            }
            long start = System.nanoTime();
            Object value = m.invoke(target, values);
            double ms = (System.nanoTime() - start) / 1_000_000.0;
            System.out.flush();
            StringBuilder sb = new StringBuilder();
            sb.append("{\"ok\":true,\"timeMs\":").append(Math.round(ms * 100) / 100.0).append(",\"value\":");
            toJson(value, sb);
            sb.append('}');
            write(result, sb.toString());
        } catch (InvocationTargetException e) {
            System.out.flush();
            write(result, "{\"ok\":false,\"error\":" + quote(stackTrace(e.getCause())) + "}");
        } catch (ClassNotFoundException e) {
            write(result, "{\"ok\":false,\"error\":" + quote("Solution 클래스가 없습니다.") + "}");
        } catch (IllegalArgumentException e) {
            write(result, "{\"ok\":false,\"error\":" + quote(e.getMessage()) + "}");
        }
    }

    private static Method findSolution(Class<?> cls, int arity) {
        for (Method m : cls.getDeclaredMethods()) if (m.getName().equals("solution") && m.getParameterCount() == arity) return m;
        return null;
    }

    private static void write(Path p, String s) throws Exception {
        Files.writeString(p, s, StandardCharsets.UTF_8);
    }

    private static String stackTrace(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        // 실행기 내부 프레임은 숨긴다
        StringBuilder out = new StringBuilder();
        for (String line : sw.toString().split("\n")) {
            if (line.contains("jdk.internal.reflect") || line.contains("java.lang.reflect.Method.invoke") || line.contains("SolvelineHarness")) continue;
            out.append(line).append('\n');
        }
        return out.toString().trim();
    }

    // ─── JSON → Java ───

    private static Object convert(Object v, Type t, String where) {
        if (t instanceof Class<?> c) {
            if (c.isArray()) return toArray(v, c.getComponentType(), c.getComponentType(), where);
            return scalar(v, c, where);
        }
        if (t instanceof GenericArrayType g) {
            Type comp = g.getGenericComponentType();
            return toArray(v, raw(comp), comp, where);
        }
        if (t instanceof ParameterizedType p) {
            Class<?> r = raw(p);
            Type[] a = p.getActualTypeArguments();
            if (Map.class.isAssignableFrom(r)) {
                if (!(v instanceof Map<?, ?> src)) throw bad(where, "객체");
                Map<Object, Object> out = new HashMap<>();
                for (Map.Entry<?, ?> e : src.entrySet()) out.put(convert(e.getKey(), a[0], where), convert(e.getValue(), a[1], where));
                return out;
            }
            if (Collection.class.isAssignableFrom(r)) {
                if (!(v instanceof List<?> src)) throw bad(where, "배열");
                Collection<Object> out = Set.class.isAssignableFrom(r) ? new HashSet<>() : new ArrayList<>();
                for (Object x : src) out.add(convert(x, a[0], where));
                return out;
            }
        }
        throw new IllegalArgumentException(where + ": 지원하지 않는 매개변수 타입 " + t.getTypeName());
    }

    private static Class<?> raw(Type t) {
        if (t instanceof Class<?> c) return c;
        if (t instanceof ParameterizedType p) return (Class<?>) p.getRawType();
        if (t instanceof GenericArrayType g) return Array.newInstance(raw(g.getGenericComponentType()), 0).getClass();
        return Object.class;
    }

    private static Object toArray(Object v, Class<?> comp, Type compType, String where) {
        if (!(v instanceof List<?> src)) throw bad(where, "배열");
        Object arr = Array.newInstance(comp, src.size());
        for (int i = 0; i < src.size(); i++) Array.set(arr, i, convert(src.get(i), compType, where));
        return arr;
    }

    private static Object scalar(Object v, Class<?> c, String where) {
        if (c == String.class || c == CharSequence.class) {
            if (v instanceof String s) return s;
            throw bad(where, "문자열");
        }
        if (c == char.class || c == Character.class) {
            if (v instanceof String s && s.length() == 1) return s.charAt(0);
            throw bad(where, "한 글자 문자열");
        }
        if (c == boolean.class || c == Boolean.class) {
            if (v instanceof Boolean b) return b;
            throw bad(where, "true/false");
        }
        if (v instanceof Number n) {
            if (c == int.class || c == Integer.class) return n.intValue();
            if (c == long.class || c == Long.class) return n.longValue();
            if (c == double.class || c == Double.class) return n.doubleValue();
            if (c == float.class || c == Float.class) return n.floatValue();
            if (c == short.class || c == Short.class) return n.shortValue();
            if (c == byte.class || c == Byte.class) return n.byteValue();
            if (c == Object.class || c == Number.class) return n;
        }
        if (c == Object.class) return v;
        throw bad(where, c.getSimpleName());
    }

    private static IllegalArgumentException bad(String where, String expected) {
        return new IllegalArgumentException(where + ": " + expected + " 형식의 값이 필요합니다.");
    }

    // ─── Java → JSON ───

    private static void toJson(Object v, StringBuilder sb) {
        if (v == null) sb.append("null");
        else if (v instanceof String s) sb.append(quote(s));
        else if (v instanceof Character ch) sb.append(quote(String.valueOf(ch)));
        else if (v instanceof Boolean b) sb.append(b);
        else if (v instanceof Double d) num(d, sb);
        else if (v instanceof Float f) num(f.doubleValue(), sb);
        else if (v instanceof Number n) sb.append(n.longValue());
        else if (v.getClass().isArray()) {
            sb.append('[');
            for (int i = 0, n = Array.getLength(v); i < n; i++) {
                if (i > 0) sb.append(',');
                toJson(Array.get(v, i), sb);
            }
            sb.append(']');
        } else if (v instanceof Collection<?> col) {
            sb.append('[');
            boolean first = true;
            for (Object x : col) {
                if (!first) sb.append(',');
                first = false;
                toJson(x, sb);
            }
            sb.append(']');
        } else if (v instanceof Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(quote(String.valueOf(e.getKey()))).append(':');
                toJson(e.getValue(), sb);
            }
            sb.append('}');
        } else sb.append(quote(v.toString()));
    }

    private static void num(double d, StringBuilder sb) {
        if (Double.isNaN(d) || Double.isInfinite(d)) sb.append(quote(Double.toString(d)));
        else sb.append(Double.toString(d).replace("E", "e"));
    }

    static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.append('"').toString();
    }

    /** 최소 JSON 파서: 정수는 Long, 실수는 Double, 배열은 List, 객체는 Map. */
    static final class Json {
        private final String s;
        private int i;

        Json(String s) {
            this.s = s;
        }

        Object parse() {
            Object v = value();
            ws();
            if (i != s.length()) throw err();
            return v;
        }

        private Object value() {
            ws();
            if (i >= s.length()) throw err();
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++;
            ws();
            if (peek('}')) return m;
            do {
                ws();
                String k = string();
                ws();
                expect(':');
                m.put(k, value());
                ws();
            } while (accept(','));
            expect('}');
            return m;
        }

        private List<Object> array() {
            List<Object> l = new ArrayList<>();
            i++;
            ws();
            if (peek(']')) return l;
            do l.add(value()); while (acceptWs(','));
            ws();
            expect(']');
            return l;
        }

        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> sb.append('\n');
                    case 't' -> sb.append('\t');
                    case 'r' -> sb.append('\r');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'u' -> { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    default -> sb.append(e);
                }
            }
            throw err();
        }

        private Number number() {
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String t = s.substring(st, i);
            if (t.isEmpty()) throw err();
            if (t.contains(".") || t.contains("e") || t.contains("E")) return Double.parseDouble(t);
            return Long.parseLong(t);
        }

        private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        private boolean peek(char c) { if (i < s.length() && s.charAt(i) == c) { i++; return true; } return false; }
        private boolean accept(char c) { return peek(c); }
        private boolean acceptWs(char c) { ws(); return peek(c); }
        private void expect(char c) { if (!peek(c)) throw err(); }
        private IllegalArgumentException err() { return new IllegalArgumentException("JSON 형식 오류 (위치 " + i + ")"); }
    }

}
