import { readdir, readFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
const root = new URL("../dist/client/assets/", import.meta.url);
let total = 0;
for (const name of await readdir(root)) {
  if (!name.endsWith(".js")) continue;
  const src = await readFile(new URL(name, root));
  if (
    /pi_journal|pg_try_advisory_lock|CONTROLLER_KEY|DATABASE_URL/.test(
      src.toString(),
    )
  )
    throw Error("server code in browser build");
  total += brotliCompressSync(src).length;
}
if (!total || total > 40000) throw Error(`Client JS budget exceeded: ${total}`);
console.log(`Client JS: ${total} Brotli bytes`);
