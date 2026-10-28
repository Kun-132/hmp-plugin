// Scan only the new chunk: indexOf on the growing buffer flattens it every time, which made a 16 MiB line quadratic.
export function lineSplitter(consume, done = () => false) {
  let pending = '';
  return {
    write(chunk) {
      let start = 0, end;
      while (!done() && (end = chunk.indexOf('\n', start)) >= 0) {
        consume(pending + chunk.slice(start, end)); pending = ''; start = end + 1;
      }
      if (!done()) pending += chunk.slice(start);
    },
    rest() { const value = pending; pending = ''; return value; },
    clear() { pending = ''; },
  };
}
