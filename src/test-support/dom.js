export function setupDom() {
  const listeners = new Map();
  const makeEl = (tag = 'div') => {
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      childNodes: [],
      children: [],
      style: {},
      options: [],
      ownerDocument: null,
      addEventListener: (type, fn) => {
        if (!listeners.has(node)) listeners.set(node, new Map());
        const m = listeners.get(node);
        if (!m.has(type)) m.set(type, []);
        m.get(type).push(fn);
      },
      removeEventListener: () => {},
      appendChild: (child) => {
        node.childNodes.push(child);
        child.parentNode = node;
        if (child.tagName === 'OPTION') node.options.push(child);
        return child;
      },
      removeChild: (child) => {
        const idx = node.childNodes.indexOf(child);
        if (idx >= 0) node.childNodes.splice(idx, 1);
        const optIdx = node.options.indexOf(child);
        if (optIdx >= 0) node.options.splice(optIdx, 1);
        return child;
      },
      insertBefore: (child) => {
        node.childNodes.push(child);
        child.parentNode = node;
        if (child.tagName === 'OPTION') node.options.push(child);
        return child;
      },
      setAttribute: () => {},
      removeAttribute: () => {},
      focus: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      get textContent() {
        return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
      },
      set textContent(v) {
        this.childNodes = v ? [{ nodeType: 3, nodeValue: String(v) }] : [];
      },
    };
    return node;
  };
  globalThis.HTMLIFrameElement = class HTMLIFrameElement {};
  globalThis.document = {
    nodeType: 9,
    nodeName: '#document',
    visibilityState: 'hidden',
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    createComment: () => ({ nodeType: 8 }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.window = globalThis;
  globalThis.dispatchEvent = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { makeEl };
}

export function find(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const res = find(child, predicate);
    if (res) return res;
  }
  return null;
}

