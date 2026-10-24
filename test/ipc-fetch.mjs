// Test-only transport for environments which deny loopback listen(). Production never imports this.
if (process.send) {
  let next = 0;
  globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const finish = () => { process.removeListener('message', receive); options.signal?.removeEventListener('abort', abort); };
    const receive = message => {
      if (message.id !== id) return;
      finish(); resolve(new Response(message.body, { status: message.status, headers: { 'Content-Type': 'application/json' } }));
    };
    const abort = () => { finish(); reject(Error('aborted')); };
    if (options.signal?.aborted) { abort(); return; }
    process.on('message', receive); options.signal?.addEventListener('abort', abort, { once: true });
    process.send({ type: 'test_http', id, method: options.method ?? 'GET', url, body: options.body ?? '' });
  });
  // The pending HTTP listener keeps the port alive only while a request is in flight.
  process.channel.unref();
}
