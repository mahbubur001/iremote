import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PathMapper, toSlash } from '../../src/core/PathMapper';

const server = (over: Partial<ConstructorParameters<typeof PathMapper>[1]> = {}) => ({
  rootPath: '/var/www',
  webUrl: 'https://example.com',
  mappings: [{ local: '', remote: '/html', web: '/' }],
  excludedLocal: [],
  excludedRemote: [],
  ...over,
});

test('maps project files to the deployment path under the root', () => {
  const m = new PathMapper('/proj', server(), []);
  assert.equal(m.toRemote('/proj/index.php'), '/var/www/html/index.php');
  assert.equal(m.toRemote('/proj'), '/var/www/html');
  assert.equal(m.toRemote('/other/file'), undefined);
});

test('reverse mapping returns the local path', () => {
  const m = new PathMapper('/proj', server(), []);
  assert.equal(m.toLocal('/var/www/html/a/b.txt'), '/proj/a/b.txt');
  assert.equal(m.toLocal('/var/www/html'), '/proj');
  assert.equal(m.toLocal('/var/www/other'), undefined);
  assert.equal(m.toLocal('/var/www/htmlx/file'), undefined, 'prefix must match on a path boundary');
});

test('the longest local mapping wins', () => {
  const m = new PathMapper(
    '/proj',
    server({
      mappings: [
        { local: '', remote: '/html', web: '/' },
        { local: 'public/assets', remote: '/cdn', web: '/static' },
      ],
    }),
    [],
  );
  assert.equal(m.toRemote('/proj/public/assets/app.js'), '/var/www/cdn/app.js');
  assert.equal(m.toRemote('/proj/public/index.php'), '/var/www/html/public/index.php');
  assert.equal(m.toLocal('/var/www/cdn/app.js'), '/proj/public/assets/app.js');
});

test('excluded names match any segment and wildcards', () => {
  const m = new PathMapper('/proj', server(), ['.git', '*.log', 'node_modules']);
  assert.ok(m.isLocalExcluded('/proj/.git/config'));
  assert.ok(m.isLocalExcluded('/proj/storage/app.log'));
  assert.ok(m.isLocalExcluded('/proj/a/node_modules/x/index.js'));
  assert.ok(!m.isLocalExcluded('/proj/src/app.ts'));
  assert.ok(m.isRemoteExcluded('/var/www/html/.git/HEAD'));
  assert.ok(!m.isDeployable('/proj/debug.log'));
  assert.ok(m.isDeployable('/proj/index.php'));
});

test('excluded local and remote paths', () => {
  const m = new PathMapper('/proj', server({ excludedLocal: ['vendor'], excludedRemote: ['/var/www/html/uploads'] }), []);
  assert.ok(m.isLocalExcluded('/proj/vendor/autoload.php'));
  assert.ok(!m.isLocalExcluded('/proj/vendors.txt'));
  assert.ok(m.isRemoteExcluded('/var/www/html/uploads/a.png'));
  assert.ok(!m.isRemoteExcluded('/var/www/html/uploadsx'));
});

test('web URLs combine web path and relative path with encoding', () => {
  const m = new PathMapper('/proj', server({ mappings: [{ local: '', remote: '/html', web: '/app' }] }), []);
  assert.equal(m.webUrlForLocal('/proj/a b/index.php'), 'https://example.com/app/a%20b/index.php');
  assert.equal(new PathMapper('/proj', server({ webUrl: '' }), []).webUrlForLocal('/proj/x'), undefined);
});

test('root path "/" and deployment path "/" map to the server root', () => {
  const m = new PathMapper('/proj', server({ rootPath: '/', mappings: [{ local: '', remote: '/', web: '/' }] }), []);
  assert.equal(m.toRemote('/proj/x.php'), '/x.php');
  assert.equal(m.toLocal('/x.php'), '/proj/x.php');
});

test('windows paths are matched case-insensitively', () => {
  const m = new PathMapper('C:\\Proj', server(), [], 'win32');
  assert.equal(m.toRemote('c:\\proj\\Index.php'), '/var/www/html/Index.php');
});

test('toSlash normalizes separators and trailing slashes', () => {
  assert.equal(toSlash('C:\\a\\b\\'), 'C:/a/b');
  assert.equal(toSlash('/a/b/'), '/a/b');
  assert.equal(toSlash('C:/'), 'C:/');
});
