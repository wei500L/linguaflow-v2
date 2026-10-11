import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Test-only pause. Production leaves both variables unset, so this returns immediately. */
export async function testBarrier(point: string) {
  const dir = process.env.LINGUAFLOW_BARRIER_DIR;
  const wanted = process.env.LINGUAFLOW_BARRIER;
  if (!dir || !wanted || wanted !== point) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${point}.ready`), new Date().toISOString());
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await access(join(dir, `${point}.go`));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
