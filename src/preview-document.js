// Permit submit events in the opaque frame. The document CSP still blocks native form navigation.
export const previewSandbox = 'allow-scripts allow-forms';

// Validate navigation sent by the opaque frame before mounting another project page.
export function previewRoute(data, files) {
  if (data?.type !== 'navigate' || typeof data.page !== 'string' || !data.page.endsWith('.html') ||
      !Object.hasOwn(files, data.page) || typeof data.search !== 'string' ||
      data.search.length > 2048 || !/^(?:\?[^#\r\n]*)?$/.test(data.search)) return null;
  return { page: data.page, search: data.search };
}

export function previewStorageUpdate(storage, data) {
  if (typeof data.key !== 'string' || data.key.length > 100) return;
  if (data.value === null) delete storage[data.key];
  else if (typeof data.value === 'string' && data.value.length <= 24000 &&
      (Object.hasOwn(storage, data.key) || Object.keys(storage).length < 12)) storage[data.key] = data.value;
}

// The opaque frame receives only public project files. Platform requests stay in the parent.
function frameHost(nonce) {
  window.addEventListener('message', function init(event) {
    if (event.source !== window.parent || event.data?.type !== 'builder-preview' || !event.ports[0]) return;
    window.removeEventListener('message', init);
    const port = event.ports[0];
    const files = event.data.files;
    const activePage = event.data.page;
    const pathBase = 'https://preview.invalid/' + activePage + event.data.search;
    let sequence = 0;
    const pending = new Map();
    const storage = Object.assign(Object.create(null), event.data.storage);
    const previewStorage = Object.freeze({
      get length() { return Object.keys(storage).length; },
      key(index) { return Object.keys(storage)[Number(index) >>> 0] ?? null; },
      getItem(key) { return storage[String(key)] ?? null; },
      setItem(key, value) {
        key = String(key);
        value = String(value);
        if (key.length > 100 || value.length > 24000 ||
            (!Object.hasOwn(storage, key) && Object.keys(storage).length >= 12)) return;
        storage[key] = value;
        port.postMessage({ type: 'storage', key, value });
      },
      removeItem(key) {
        key = String(key);
        if (!Object.hasOwn(storage, key)) return;
        delete storage[key];
        port.postMessage({ type: 'storage', key, value: null });
      },
      clear() {
        for (const key of Object.keys(storage)) previewStorage.removeItem(key);
      }
    });
    window.previewStorage = previewStorage;
    // Install an own property before project scripts run. The native getter throws in an opaque frame.
    Object.defineProperty(window, 'localStorage', { value: previewStorage });
    port.onmessage = ({ data }) => {
      const callback = pending.get(data.id);
      if (!callback) return;
      pending.delete(data.id);
      callback(new Response([204, 205, 304].includes(data.status) ? null : JSON.stringify(data.body), {
        status: data.status, headers: { 'content-type': 'application/json' }
      }));
    };
    window.fetch = async (input, options) => {
      const address = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      const url = new URL(address, pathBase);
      if (url.origin !== 'https://preview.invalid' || !url.pathname.startsWith('/api/')) {
        throw new TypeError('预览只能请求本项目的 /api/ 接口');
      }
      const method = (options?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      let body = null;
      const raw = options?.body ?? (input instanceof Request && !['GET', 'HEAD'].includes(method) ? await input.text() : null);
      if (raw != null) {
        if (typeof raw !== 'string' || raw.length > 70000) throw new TypeError('接口请求必须是 JSON');
        body = JSON.parse(raw);
      }
      return new Promise((resolve) => {
        const id = ++sequence;
        pending.set(id, resolve);
        port.postMessage({ type: 'request', id, method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      });
    };
    function asset(value) {
      try {
        const url = new URL(value, pathBase);
        return url.origin === 'https://preview.invalid' ? decodeURIComponent(url.pathname.slice(1)) : '';
      } catch {
        return '';
      }
    }
    function projectPage(value) {
      const page = asset(value);
      if (!page.endsWith('.html') || !Object.hasOwn(files, page)) return null;
      const url = new URL(value, pathBase);
      return { page, search: url.search };
    }
    function navigate(value) {
      const route = projectPage(value);
      if (route) port.postMessage({ type: 'navigate', ...route });
    }
    window.previewLocation = Object.freeze({
      pathname: '/' + activePage, search: event.data.search, navigate
    });
    const documentData = new DOMParser().parseFromString(files[activePage] || '', 'text/html');
    const scripts = Array.from(documentData.querySelectorAll('script')).map((original) => {
      const path = original.getAttribute('src');
      return { text: path ? files[asset(path)] : original.textContent, type: original.getAttribute('type') };
    });
    for (const node of documentData.querySelectorAll('base, meta, script, iframe, frame, object, embed, video, audio, source:not(picture > source)')) node.remove();
    const styles = Array.from(documentData.querySelectorAll('style')).map((style) => style.textContent);
    for (const node of documentData.querySelectorAll('style, link')) {
      if (node.tagName === 'LINK' && node.getAttribute('rel') === 'stylesheet') {
        const css = files[asset(node.getAttribute('href') || '')];
        if (typeof css === 'string') styles.push(css);
      }
      node.remove();
    }
    for (const node of documentData.querySelectorAll('a')) {
      const href = node.getAttribute('href') || '#';
      node.removeAttribute('target');
      node.removeAttribute('ping');
      node.removeAttribute('download');
      node.removeAttribute('href');
      node.removeAttribute('xlink:href');
      if (href.startsWith('#')) node.setAttribute('href', href);
      else if (projectPage(href)) {
        node.setAttribute('href', '#');
        node.setAttribute('data-preview-href', href);
      }
    }
    document.addEventListener('click', (event) => {
      const link = event.target?.closest?.('a');
      if (!link) return;
      const href = link.getAttribute('data-preview-href') || link.getAttribute('href');
      if (!href || (href.startsWith('#') && !link.hasAttribute('data-preview-href'))) return;
      event.preventDefault();
      navigate(href);
    }, true);
    document.addEventListener('submit', (event) => event.preventDefault());
    document.title = documentData.title;
    for (const attribute of documentData.documentElement.attributes) {
      if (['lang', 'dir', 'class'].includes(attribute.name)) document.documentElement.setAttribute(attribute.name, attribute.value);
    }
    for (const attribute of documentData.body.attributes) {
      if (['id', 'class', 'style'].includes(attribute.name) || attribute.name.startsWith('data-')) document.body.setAttribute(attribute.name, attribute.value);
    }
    for (const css of styles) {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
    }
    document.body.replaceChildren(...documentData.body.childNodes);
    for (const script of scripts) {
      if (typeof script.text !== 'string' || ![null, '', 'text/javascript', 'module'].includes(script.type)) continue;
      const element = document.createElement('script');
      element.nonce = nonce;
      if (script.type === 'module') element.type = 'module';
      element.textContent = script.text;
      document.body.append(element);
    }
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.documentElement.dataset.builderPreviewReady = 'true';
  });
}

export function createPreviewDocument({ allowExternalImages = false } = {}) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const imageSources = allowExternalImages ? 'data: https:' : 'data:';
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + nonce +
    '\'; style-src \'unsafe-inline\'; img-src ' + imageSources + '; font-src data:; form-action \'none\'; base-uri \'none\'">' +
    '<body><script nonce="' + nonce + '">(' + frameHost.toString() + ')(' + JSON.stringify(nonce) + ');<\/script></body></html>';
}
