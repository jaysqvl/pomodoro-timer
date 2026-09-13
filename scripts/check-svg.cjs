/* Exercise the installed SVG dependency branches and CRA's real loader rule.
 * CRA disables SVGO in its React-component loader. These plugin checks verify
 * the advisory fix if removal is enabled; they do not claim SVG sanitization.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');

process.env.NODE_ENV = 'development';
process.env.BABEL_ENV = 'development';

const appRoot = path.resolve(__dirname, '..');
const craRequire = createRequire(require.resolve('react-scripts/package.json'));
const loaderPath = craRequire.resolve('@svgr/webpack');
const loaderRequire = createRequire(loaderPath);
const pluginRequire = createRequire(loaderRequire.resolve('@svgr/plugin-svgo'));
const cssRequire = createRequire(require.resolve('postcss-svgo'));

for (const [branch, dependencyRequire, expectedVersion] of [
  ['SVGR', pluginRequire, '3.3.5'],
  ['CSS optimization', cssRequire, '2.8.4'],
]) {
  test(branch + ' uses the patched SVGO release and removes script-link bypasses', () => {
    const svgo = dependencyRequire('svgo');
    const version = dependencyRequire('svgo/package.json').version;
    assert.equal(version, expectedVersion);
    const payloads = [
      '<script>alert(1)</script>',
      '<a href="javascript:alert(1)"><rect width="10" height="10"/></a>',
      '<svg:a xmlns:svg="http://www.w3.org/2000/svg" xlink:href="javascript:alert(1)"><rect width="10" height="10"/></svg:a>',
      '<a xmlns:link="http://www.w3.org/1999/xlink" link:href="javascript:alert(1)"><rect width="10" height="10"/></a>',
      ...['&#9;', '&#10;', '&#13;'].map(space =>
        '<a href="java' + space + 'script:alert(1)"><rect width="10" height="10"/></a>'),
    ];
    for (const payload of payloads) {
      const input = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' + payload + '</svg>';
      const { data } = svgo.optimize(input, { plugins: ['removeScriptElement'] });
      assert.doesNotMatch(data, /alert\(1\)|<script/i, input + '\n' + data);
    }
    const benign = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><a href="https://example.com/"><rect width="10" height="10" fill="red"/></a></svg>';
    const { data } = svgo.optimize(benign, { plugins: ['removeScriptElement'] });
    assert.match(data, /https:\/\/example\.com\//);
    assert.match(data, /<rect[^>]*fill="red"/);
    assert.match(data, /viewBox="0 0 20 20"/);
  });
}

test('the lockfile contains no affected SVGO release', () => {
  const lock = require('../package-lock.json');
  const entries = Object.entries(lock.packages)
    .filter(([location]) => /(^|\/)node_modules\/svgo$/.test(location));
  assert.ok(entries.length > 0);
  for (const [location, dependency] of entries) {
    assert.ok(['2.8.4', '3.3.5'].includes(dependency.version), location + ': ' + dependency.version);
  }
});

test('the existing CSS optimizer preserves a benign SVG data URL', async () => {
  const postcss = require('postcss');
  const postcssSvgo = require('postcss-svgo');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/></svg>';
  const css = '.icon { background: url("data:image/svg+xml,' + encodeURIComponent(svg) + '"); }';
  const result = await postcss([postcssSvgo()]).process(css, { from: undefined });
  const decoded = decodeURIComponent(result.css);
  assert.match(decoded, /data:image\/svg\+xml/);
  assert.match(decoded, /<circle/);
  assert.match(decoded, /viewBox=['"]0 0 24 24['"]/);
});

test('CRA preserves SVG URL and ReactComponent exports, props, title, and ref', async () => {
  const webpack = require('webpack');
  const makeConfig = require('react-scripts/config/webpack.config');
  const svgRule = makeConfig('development').module.rules
    .flatMap(rule => rule.oneOf || [])
    .find(rule => rule.test instanceof RegExp && rule.test.test('fixture.svg'));
  assert.ok(svgRule, 'CRA SVG rule is present');
  assert.equal(svgRule.use[0].loader, loaderPath);
  assert.equal(svgRule.use[0].options.svgo, false);
  assert.equal(loaderRequire('@svgr/webpack/package.json').version, '8.1.0');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra-svg-contract-'));
  const compiler = webpack({
    mode: 'development',
    target: 'node',
    context: appRoot,
    entry: path.join(__dirname, 'fixtures/svg-contract.js'),
    output: { path: outputDir, filename: 'bundle.cjs', library: { type: 'commonjs2' }, publicPath: '/' },
    module: { rules: [svgRule] },
    externals: { react: 'commonjs ' + require.resolve('react') },
    optimization: { minimize: false },
  });

  try {
    await new Promise((resolve, reject) => compiler.run((error, stats) => {
      if (error) return reject(error);
      if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve();
    }));
    const { svgUrl, Svg } = require(path.join(outputDir, 'bundle.cjs'));
    assert.match(svgUrl, /^\/static\/media\/svg-contract\.[a-f0-9]+\.svg$/);
    const emitted = fs.readFileSync(path.join(outputDir, svgUrl.slice(1)), 'utf8');
    assert.match(emitted, /viewBox="0 0 24 24"/);

    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const previous = new Map();
    for (const [name, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    let root;
    try {
      const React = require('react');
      const { createRoot } = require('react-dom/client');
      const act = React.act || require('react-dom/test-utils').act;
      const ref = React.createRef();
      root = createRoot(document.getElementById('root'));
      await act(async () => root.render(React.createElement(Svg, {
        ref, title: 'Accessible sample', titleId: 'sample-title',
        className: 'forwarded-class', 'data-contract': 'forwarded',
      })));
      const svg = document.querySelector('svg');
      assert.equal(ref.current, svg);
      assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
      assert.equal(svg.getAttribute('data-contract'), 'forwarded');
      assert.equal(svg.getAttribute('class'), 'forwarded-class');
      assert.equal(svg.getAttribute('aria-labelledby'), 'sample-title');
      assert.equal(svg.querySelector('title').textContent, 'Accessible sample');
      assert.ok(svg.querySelector('circle'));
      await act(async () => root.unmount());
      root = null;
    } finally {
      if (root) root.unmount();
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  } finally {
    await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
