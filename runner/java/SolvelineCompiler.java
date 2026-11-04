import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Stream;
import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;

/**
 * 예열 컴파일 서버(0012 4단계). runner 서버가 전용 uid로 띄우고 stdin/stdout으로만 주고받는다.
 *
 * <p>요청 한 줄: {@code <id> <소스 폴더> <파일 이름>}. 응답: {@code <id> <종료 코드> <바이트 수>} 한 줄 뒤에 진단 문구(UTF-8).
 * javac 명령과 같은 옵션·같은 출력 형식으로 컴파일하고, 결과는 {@code <소스 폴더>/out}에 쓴다.
 * 사용자 코드를 실행하지 않는다(애너테이션 처리 끔). 잘못되면 runner가 이 프로세스를 끝내고 다시 띄운다.
 */
public final class SolvelineCompiler {
    private static final JavaCompiler JAVAC = ToolProvider.getSystemJavaCompiler();
    private static final Object OUT_LOCK = new Object();

    public static void main(String[] argv) throws Exception {
        int threads = Math.max(1, Integer.parseInt(argv[0]));
        String classpath = argv[1];
        warmUp(classpath);
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        OutputStream out = System.out;
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        out.write("ready\n".getBytes(StandardCharsets.UTF_8));
        out.flush();
        for (String line; (line = in.readLine()) != null; ) {
            String[] p = line.split(" ");
            if (p.length != 3) continue;
            pool.execute(() -> reply(out, p[0], compile(Path.of(p[1]), p[2], classpath)));
        }
        pool.shutdown();
    }

    /** javac 명령과 같은 옵션. 경로는 runner가 상대 경로로 바꿔 보여 준다. */
    static Result compile(Path dir, String file, String classpath) {
        ByteArrayOutputStream diag = new ByteArrayOutputStream();
        int code;
        try (PrintStream ps = new PrintStream(diag, true, StandardCharsets.UTF_8)) {
            code = JAVAC.run(null, ps, ps, "-encoding", "UTF-8", "-g:none", "-Xlint:deprecation", "-proc:none",
                    "-d", dir.resolve("out").toString(), "-cp", classpath, dir.resolve(file).toString());
        } catch (RuntimeException | Error e) {
            code = 4; // javac 내부 오류(javac 명령의 종료 코드 4와 같다)
            diag.writeBytes(("컴파일러 오류: " + e).getBytes(StandardCharsets.UTF_8));
        }
        return new Result(code, diag.toByteArray());
    }

    static void reply(OutputStream out, String id, Result r) {
        synchronized (OUT_LOCK) {
            try {
                out.write((id + " " + r.code + " " + r.diag.length + "\n").getBytes(StandardCharsets.UTF_8));
                out.write(r.diag);
                out.flush();
            } catch (IOException e) {
                System.exit(1); // runner가 끊겼다
            }
        }
    }

    /** 첫 요청이 느리지 않게 미리 몇 번 컴파일해 JIT를 데운다 */
    static void warmUp(String classpath) throws IOException {
        Path dir = Files.createTempDirectory("compiler-warm-");
        try {
            Files.writeString(dir.resolve("Solution.java"),
                    "import java.util.*;\nclass Solution { int solution(int[] a) { List<Integer> l = new ArrayList<>(); for (int x : a) l.add(x); return l.stream().mapToInt(Integer::intValue).sum(); } }\n");
            for (int i = 0; i < 5; i++) compile(dir, "Solution.java", classpath);
        } finally {
            try (Stream<Path> s = Files.walk(dir)) {
                s.sorted(Comparator.reverseOrder()).forEach(f -> f.toFile().delete());
            }
        }
    }

    record Result(int code, byte[] diag) {}
}
