// 文件日志。门卫跑在宿主进程里，没有控制台可看，出问题只能翻日志。
// 顺手做了大小滚动，避免一年后 bili-gate.log 长到几百 MB。
import fs from 'node:fs';
import path from 'node:path';

const CHECK_EVERY = 50;

export function createLogger({ file, maxBytes = 1_048_576, stdout = false } = {}) {
  let writes = 0;
  let broken = false;

  const rotateIfNeeded = () => {
    if (!file || broken) return;
    try {
      const st = fs.statSync(file);
      if (st.size < maxBytes) return;
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* 文件还不存在、或者被人占着：都不影响继续写 */
    }
  };

  const write = (level, parts) => {
    const line = `[${new Date().toISOString()}] [${level}] ${parts
      .map((a) => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ')}\n`;
    if (stdout) {
      try {
        process.stdout.write(line);
      } catch {
        /* ignore */
      }
    }
    if (!file || broken) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (writes++ % CHECK_EVERY === 0) rotateIfNeeded();
      fs.appendFileSync(file, line);
    } catch {
      // 日志写不进去不该把门卫带崩，但也没别的地方能说，只能闭嘴。
      broken = true;
    }
  };

  return {
    file,
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
