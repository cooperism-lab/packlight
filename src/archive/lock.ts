import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
};

/** One packlight process changes the setup at a time (CEO F2). A lock left by a dead process is taken over. */
export function acquireLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(file, 'utf8'));
      if (pid && alive(pid) && pid !== process.pid) throw new Error(`Another packlight (process ${pid}) is changing your setup. Wait for it to finish.`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not take the lock at ${file}.`);
}
