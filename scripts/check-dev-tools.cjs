'use strict';

// Test the actual CRA callers with bounded, loopback-only fixtures. No provider
// credentials, external requests, editor launches, or application data are used.
process.env.NODE_ENV = 'development';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { once } = require('node:events');

const cra = createRequire(require.resolve('react-scripts/package.json'));
const wds = createRequire(cra.resolve('webpack-dev-server/package.json'));
const webpack = cra('webpack');
const WebpackDevServer = cra('webpack-dev-server');
const express = wds('express');
const { fixRequestBody } = wds('http-proxy-middleware');
const WebSocket = wds('ws');
const sockjs = createRequire(wds.resolve('sockjs/package.json'));
const Faye = sockjs('faye-websocket');
const faye = createRequire(sockjs.resolve('faye-websocket/package.json'));
const driver = faye('websocket-driver');
const jsdom = createRequire(require.resolve('jsdom/package.json'));
const FormData = jsdom('form-data');
const devUtils = createRequire(cra.resolve('react-dev-utils/package.json'));
const shellQuote = devUtils('shell-quote');

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('loopback fixture timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await bounded(once(server, 'listening'));
  return server.address().port;
}

async function closeHttp(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await bounded(closed);
}

function request(port, pathname, options = {}, body) {
  return bounded(new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname,
      ...options, agent: false,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 65536) res.destroy(new Error('fixture response too large'));
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body);
  }));
}

test('CRA dev-server starts, compiles, parses HTTP, proxies bodies, and opens its WebSocket', { timeout: 30000 }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cra-dev-contract-'));
  let compiler, server, upstream, socket;
  t.after(async () => {
    if (socket) socket.terminate();
    if (server) await server.stop();
    if (compiler) await bounded(new Promise((resolve, reject) =>
      compiler.close(error => error ? reject(error) : resolve())));
    if (upstream) await closeHttp(upstream);
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(fixture, 'entry.js'), 'console.log("dependency-contract-ok");\n');

  upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.statusCode = req.url.includes('/unavailable') ? 503 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ path: req.url, host: req.headers.host, body }));
    });
  });
  const upstreamPort = await listen(upstream);
  compiler = webpack({
    mode: 'development',
    entry: path.join(fixture, 'entry.js'),
    output: { path: path.join(fixture, 'out'), filename: 'bundle.js' },
    infrastructureLogging: { level: 'error' },
    stats: 'errors-only',
  });
  const config = cra('./config/webpackDevServer.config.js')([{
    context: '/__proxy',
    target: 'http://127.0.0.1:' + upstreamPort,
    pathRewrite: { '^/__proxy': '/echo' },
    changeOrigin: true,
    onProxyReq: fixRequestBody,
    logLevel: 'silent',
  }], '127.0.0.1');
  const originalBefore = config.onBeforeSetupMiddleware;
  Object.assign(config, {
    host: '127.0.0.1', port: 0, open: false, static: false,
    hot: false, liveReload: false, client: false, setupExitSignals: false,
    onBeforeSetupMiddleware(server) {
      originalBefore(server);
      server.app.get('/__contract/:name', (req, res) => {
        res.cookie('session', 'fixture value', { httpOnly: true, sameSite: 'lax' });
        res.json({ name: req.params.name, query: req.query });
      });
      server.app.post('/__form', express.urlencoded({ extended: true, limit: '4kb' }),
        (req, res) => res.json(req.body));
      server.app.use('/__static', express.static(fixture));
      server.app.get('/__redirect', (req, res) => res.redirect('/<script>fixture</script>'));
      server.app.post('/__proxy', express.json({ limit: '4kb' }), (req, res, next) => next());
    },
  });
  server = new WebpackDevServer(config, compiler);
  await server.start();
  const port = server.server.address().port;

  const route = await request(port, '/__contract/caf%C3%A9?items[]=1&items[]=2&options[theme]=dark&__proto__[polluted]=yes');
  assert.equal(route.status, 200);
  assert.deepEqual(JSON.parse(route.body), {
    name: 'café', query: { items: ['1', '2'], options: { theme: 'dark' } },
  });
  assert.match(route.headers['set-cookie'][0], /session=fixture%20value/);
  assert.match(route.headers['set-cookie'][0], /HttpOnly/);
  assert.equal(Object.prototype.polluted, undefined);
  const repeated = Array.from({ length: 25 }, (_, index) => 'item=' + index).join('&');
  const arrayRoute = await request(port, '/__contract/array?' + repeated);
  assert.deepEqual(JSON.parse(arrayRoute.body).query.item,
    Array.from({ length: 25 }, (_, index) => String(index)));

  const form = await request(port, '/__form', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, 'name=fixture&options[theme]=dark&items[]=1&items[]=2');
  assert.equal(form.status, 200);
  assert.deepEqual(JSON.parse(form.body), {
    name: 'fixture', options: { theme: 'dark' }, items: ['1', '2'],
  });

  const proxyGet = await request(port, '/__proxy/value?term=a%20b');
  assert.equal(proxyGet.status, 200);
  assert.equal(JSON.parse(proxyGet.body).path, '/echo/value?term=a%20b');
  assert.equal(JSON.parse(proxyGet.body).host, '127.0.0.1:' + upstreamPort);
  const payload = JSON.stringify({ message: 'café ✓', count: 2 });
  const proxyPost = await request(port, '/__proxy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  }, payload);
  assert.equal(proxyPost.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(proxyPost.body).body), JSON.parse(payload));
  assert.equal((await request(port, '/__proxy/unavailable')).status, 503);
  assert.equal((await request(port, '/__proxy/recovered')).status, 200);

  const staticFile = await request(port, '/__static/entry.js');
  assert.equal(staticFile.status, 200);
  assert.equal(staticFile.body, 'console.log("dependency-contract-ok");\n');
  const range = await request(port, '/__static/entry.js', { headers: { Range: 'bytes=0-6' } });
  assert.equal(range.status, 206);
  assert.equal(range.body, 'console');
  assert.match(range.headers['content-range'], /^bytes 0-6\//);
  const redirect = await request(port, '/__redirect');
  assert.equal(redirect.status, 302);
  assert.ok(!redirect.body.includes('<script>'));
  assert.ok(redirect.headers.location.includes('%3Cscript%3E'));

  const bundle = await request(port, '/bundle.js');
  assert.equal(bundle.status, 200);
  assert.match(bundle.body, /dependency-contract-ok/);
  socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', {
    headers: { Origin: 'http://127.0.0.1:' + port },
  });
  const [message] = await bounded(once(socket, 'message'));
  assert.equal(typeof JSON.parse(message.toString()).type, 'string');
  const closed = once(socket, 'close');
  socket.close();
  await bounded(closed);
});

test('proxy router requires an exact host and path prefix, not a substring', async () => {
  const { getTarget } = wds('http-proxy-middleware/dist/router');
  const config = { router: { 'fixture.local/api': 'http://127.0.0.1:9000' } };
  assert.equal(await getTarget({ headers: { host: 'fixture.local' }, url: '/api/items' }, config),
    'http://127.0.0.1:9000');
  assert.equal(await getTarget({ headers: { host: 'other.local' }, url: '/else/fixture.local/api/items' }, config),
    undefined);
  assert.equal(await getTarget({ headers: { host: 'prefix.fixture.local' }, url: '/api/items' }, config),
    undefined);
});

test('legacy WebSocket rejects an oversized encoded length without losing normal text frames', () => {
  const makeDriver = () => driver.http({
    method: 'GET', url: '/socket',
    headers: { connection: 'Upgrade', upgrade: 'WebSocket', host: '127.0.0.1', origin: 'http://127.0.0.1' },
  }, { maxLength: 32 });
  const normal = makeDriver();
  const messages = [];
  normal.on('message', event => messages.push(event.data));
  normal.start();
  normal.parse(Buffer.from([0x00, ...Buffer.from('hello ✓'), 0xff]));
  assert.deepEqual(messages, ['hello ✓']);
  normal.close();
  const oversized = makeDriver();
  oversized.start();
  oversized.parse(Buffer.from([0x80, 0xff, 0xff]));
  assert.equal(oversized.readyState, 3);
});

test('the SockJS WebSocket driver preserves UTF-8 and binary echoes with a bounded size limit', { timeout: 15000 }, async t => {
  const sockets = new Set();
  const server = http.createServer();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    const ws = new Faye(req, socket, head, null, { maxLength: 512 });
    ws.on('message', event => ws.send(event.data));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await closeHttp(server);
  });
  const port = await listen(server);
  const client = new Faye.Client('ws://127.0.0.1:' + port);
  t.after(() => client.close());
  await bounded(once(client, 'open'));
  let received = once(client, 'message');
  client.send('hello café ✓');
  assert.equal((await bounded(received))[0].data, 'hello café ✓');
  received = once(client, 'message');
  client.send(Buffer.from([1, 2, 3]));
  assert.deepEqual((await bounded(received))[0].data, Buffer.from([1, 2, 3]));
  const closed = once(client, 'close');
  client.send(Buffer.alloc(1025, 1));
  assert.equal((await bounded(closed))[0].code, 1009);
});

test('jsdom multipart fields and files retain framing and escape header parameters', { timeout: 10000 }, async t => {
  const random = Math.random;
  let boundary;
  try {
    Math.random = () => { throw new Error('multipart boundary must not use Math.random'); };
    boundary = new FormData().getBoundary();
  } finally {
    Math.random = random;
  }
  assert.match(boundary, /^--------------------------[a-f0-9]{24}$/);
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: req.headers['content-type'], body }));
    });
  });
  t.after(() => closeHttp(server));
  const port = await listen(server);
  const form = new FormData();
  form.append('name', 'café ✓');
  form.append('count', 3);
  form.append('upload', Buffer.from('fixture file'), {
    filename: 'report\r\n"x".txt', contentType: 'text/plain',
  });
  const response = await bounded(new Promise((resolve, reject) => {
    const req = form.submit('http://127.0.0.1:' + port, (error, res) => {
      if (error) return reject(error);
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
    });
    req.setTimeout(4000, () => req.destroy(new Error('multipart fixture timed out')));
  }));
  assert.equal(response.status, 200);
  assert.equal(response.type, 'multipart/form-data; boundary=' + form.getBoundary());
  assert.ok(response.body.includes('name="name"\r\n\r\ncafé ✓'));
  assert.ok(response.body.includes('name="count"\r\n\r\n3'));
  assert.ok(response.body.includes('filename="report%0D%0A%22x%22.txt"'));
  assert.ok(response.body.endsWith('--' + form.getBoundary() + '--\r\n'));
});

test('editor argument parsing and shell quoting preserve literals and reject forged operator tokens', () => {
  assert.deepEqual(shellQuote.parse('code --reuse-window "file name.js"'),
    ['code', '--reuse-window', 'file name.js']);
  const literals = ['', 'file name.js', 'café', 'a; echo nope', '$HOME', 'one\ntwo', 'C:\\folder\\file'];
  assert.deepEqual(shellQuote.parse(shellQuote.quote(literals)), literals);
  assert.throws(() => shellQuote.quote([{ op: 'x\ninvalid-command' }]), TypeError);
});
