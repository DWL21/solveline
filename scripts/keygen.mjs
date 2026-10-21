// codetest 접근용 Ed25519 키쌍 생성.
// 개인키는 ~/.codetest/access.key 에만 저장하고 저장소에 두지 않는다.
// 공개키(base64url)는 API의 ACCESS_PUBLIC_KEY 에 넣는다.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".codetest");
const keyPath = join(dir, "access.key");
if (existsSync(keyPath) && !process.argv.includes("--force")) {
  console.error(`이미 존재합니다: ${keyPath} (덮어쓰려면 --force)`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const raw = publicKey.export({ format: "jwk" }).x; // base64url 32바이트
console.log(`개인키 저장: ${keyPath}`);
console.log(`ACCESS_PUBLIC_KEY=${raw}`);
