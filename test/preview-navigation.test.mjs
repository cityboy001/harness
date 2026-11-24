import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewDocument, previewRoute } from '../src/preview-document.js';

test('interactive previews opt into HTTPS images while offline browser acceptance keeps its policy', () => {
  assert.match(createPreviewDocument(), /img-src data:;/);
  const preview = createPreviewDocument({ allowExternalImages: true });
  assert.match(preview, /img-src data: https:;/);
  assert.match(preview, /default-src 'none'/);
  assert.match(preview, /name="referrer" content="no-referrer"/);
});

test('preview navigation keeps the query and accepts only existing project pages', () => {
  const files = { 'index.html': '', 'detail.html': '', 'server.js': '' };
  const route = { type: 'navigate', page: 'detail.html', search: '?id=a%2Bb' };
  assert.deepEqual(previewRoute(route, files), { page: 'detail.html', search: '?id=a%2Bb' });
  assert.equal(previewRoute({ ...route, page: 'https://example.com/detail.html' }, files), null);
  assert.equal(previewRoute({ ...route, page: 'server.js' }, files), null);
  assert.equal(previewRoute({ ...route, search: '?id=42#fragment' }, files), null);
});
