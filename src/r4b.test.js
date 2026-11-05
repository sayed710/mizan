import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function createMockDomParser() {
  return class MockDOMParser {
    parseFromString(markup, _type) {
      const makeNode = (tagName, attrs = {}, children = []) => {
        const node = {
          nodeType: 1,
          tagName: tagName.toUpperCase(),
          childNodes: [...children],
          attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
          removeAttribute(name) {
            this.attributes = this.attributes.filter((a) => a.name !== name);
          },
          remove() {
            const parent = this.parentNode || this.parent;
            if (parent) {
              const idx = parent.childNodes.indexOf(this);
              if (idx >= 0) parent.childNodes.splice(idx, 1);
            }
          },
          replaceWith(...nodes) {
            const parent = this.parentNode || this.parent;
            if (parent) {
              const idx = parent.childNodes.indexOf(this);
              if (idx >= 0) parent.childNodes.splice(idx, 1, ...nodes);
              for (const n of nodes) {
                n.parent = parent;
                n.parentNode = parent;
              }
            }
          },
          get innerHTML() {
            return this.childNodes
              .map((c) =>
                c.nodeType === 3
                  ? c.nodeValue
                  : `<${c.tagName.toLowerCase()}${c.attributes.length ? ' ' + c.attributes.map((a) => `${a.name}="${a.value}"`).join(' ') : ''}>${c.innerHTML}</${c.tagName.toLowerCase()}>`,
              )
              .join('');
          },
        };
        for (const child of children) {
          child.parent = node;
          child.parentNode = node;
        }
        return node;
      };

      const textNode = (value) => ({ nodeType: 3, nodeValue: value });

      const parseTokens = (str) => {
        const nodes = [];
        const regex = /<(\/)?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
        const stack = [{ childNodes: nodes }];
        let match;
        while ((match = regex.exec(str)) !== null) {
          const [, isClosing, tagName, attrStr, text] = match;
          if (text) {
            const tNode = textNode(text);
            stack[stack.length - 1].childNodes.push(tNode);
            tNode.parent = stack[stack.length - 1];
            tNode.parentNode = stack[stack.length - 1];
          } else if (isClosing) {
            if (stack.length > 1 && stack[stack.length - 1].tagName === tagName.toUpperCase()) {
              stack.pop();
            }
          } else {
            const attrs = {};
            if (attrStr) {
              const attrRegex = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
              let aMatch;
              while ((aMatch = attrRegex.exec(attrStr)) !== null) {
                attrs[aMatch[1]] = aMatch[2] ?? '';
              }
            }
            const el = makeNode(tagName, attrs, []);
            stack[stack.length - 1].childNodes.push(el);
            el.parent = stack[stack.length - 1];
            el.parentNode = stack[stack.length - 1];
            if (!['BR', 'HR', 'IMG', 'INPUT'].includes(tagName.toUpperCase())) {
              stack.push(el);
            }
          }
        }
        return nodes;
      };

      const body = makeNode('BODY', {}, parseTokens(String(markup ?? '')));
      return { body };
    }
  };
}

// -----------------------------------------------------------------------------
// Finding 5: Typing can throw the cursor to the top
// -----------------------------------------------------------------------------
test('Finding 5: handleInput sanitizes live DOM in place without reassigning innerHTML', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { HtmlEditor, sanitizeInPlace } = await import('./HtmlEditor.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  assert.equal(typeof sanitizeInPlace, 'function', 'sanitizeInPlace helper must be exported');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  globalThis.DOMParser = createMockDomParser();

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  let emitted = '';
  await React.act(async () => {
    root.render(
      React.createElement(HtmlEditor, {
        id: 'finding-5-editor',
        label: 'Report Body',
        value: '<p>Initial</p>',
        onChange: (v) => {
          emitted = v;
        },
      }),
    );
  });

  const editor = find(host, (n) => props(n)?.role === 'textbox');
  assert.ok(editor, 'Editor textbox must exist');

  // Build a live DOM subtree inside editor with styling/disallowed nodes:
  // e.g. <p>Hello <span style="color:red">world</span><font color="blue">!</font></p>
  const parser = new (createMockDomParser())();
  const parsed = parser.parseFromString('<p>Hello <span style="color:red">world</span><font color="blue">!</font></p>');
  editor.childNodes = [...parsed.body.childNodes];
  for (const c of editor.childNodes) {
    c.parentNode = editor;
    c.parent = editor;
  }

  // Define innerHTML getter/setter spy on editor to detect if innerHTML is reassigned
  let innerHtmlAssignments = 0;
  Object.defineProperty(editor, 'innerHTML', {
    configurable: true,
    get() {
      return this.childNodes
        .map((c) =>
          c.nodeType === 3
            ? c.nodeValue
            : `<${c.tagName.toLowerCase()}${c.attributes?.length ? ' ' + c.attributes.map((a) => `${a.name}="${a.value}"`).join(' ') : ''}>${c.innerHTML}</${c.tagName.toLowerCase()}>`,
        )
        .join('');
    },
    set(_val) {
      innerHtmlAssignments++;
    },
  });

  const initialPNode = editor.childNodes[0];
  const initialSpanNode = initialPNode.childNodes[1];

  // Trigger onInput
  await React.act(async () => {
    props(editor).onInput();
  });

  // Verify: innerHTML must NOT be reassigned
  assert.equal(innerHtmlAssignments, 0, 'handleInput must not reassign editor.innerHTML when cleaning live DOM');

  // Verify: live DOM node identity was preserved (caret/undo survivability)
  assert.equal(editor.childNodes[0], initialPNode, 'Paragraph DOM node must be preserved in place');
  assert.equal(initialPNode.childNodes[1], initialSpanNode, 'Span DOM node must be preserved in place');

  // Verify: disallowed style attribute was stripped in place
  assert.ok(!initialSpanNode.attributes.some((a) => a.name === 'style'), 'style attribute stripped from live span');

  // Verify: <font> tag was unwrapped in place
  assert.ok(!editor.innerHTML.includes('<font'), 'font tag unwrapped in place');
  assert.ok(editor.innerHTML.includes('!'), 'font text content preserved');

  // Verify: emitted value is sanitized
  assert.equal(emitted, '<p>Hello <span>world</span>!</p>', 'Emitted value must be sanitized');

  await React.act(async () => root.unmount());
});

test('Finding 5: sanitizeInPlace helper unwraps disallowed tags, strips attributes, removes script tags in place', async () => {
  const { sanitizeInPlace } = await import('./HtmlEditor.jsx');
  const parser = new (createMockDomParser())();

  const doc = parser.parseFromString(
    '<p class="intro" style="font-size:14px" onclick="hack()">Intro <font color="red">styled</font> <script>evil()</script><span style="color:blue">text</span></p>',
  );

  const pNode = doc.body.childNodes[0];
  const result = sanitizeInPlace(doc.body);

  assert.equal(result, doc.body, 'sanitizeInPlace returns the node');
  assert.equal(doc.body.childNodes[0], pNode, 'pNode identity preserved');

  // Class preserved, style and onclick stripped
  assert.ok(pNode.attributes.some((a) => a.name === 'class' && a.value === 'intro'), 'class attribute preserved');
  assert.ok(!pNode.attributes.some((a) => a.name === 'style'), 'style attribute removed from p');
  assert.ok(!pNode.attributes.some((a) => a.name === 'onclick'), 'onclick attribute removed from p');

  // Font unwrapped
  assert.ok(!doc.body.innerHTML.includes('<font'), '<font> unwrapped');
  assert.ok(doc.body.innerHTML.includes('styled'), 'font content preserved');

  // Script removed
  assert.ok(!doc.body.innerHTML.includes('script'), '<script> removed');
  assert.ok(!doc.body.innerHTML.includes('evil'), 'script content removed');

  // Span style stripped
  assert.ok(doc.body.innerHTML.includes('<span>text</span>'), 'span style stripped, span preserved');
});

// -----------------------------------------------------------------------------
// Finding 15: Dragging text inside the editor copies it
// -----------------------------------------------------------------------------
test('Finding 15: dragging text inside the editor moves it unless a copy modifier is held', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { HtmlEditor } = await import('./HtmlEditor.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  globalThis.DOMParser = createMockDomParser();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(HtmlEditor, { id: 'finding-15-editor', label: 'Report Body', value: '<p>Alpha Beta Gamma</p>', onChange: () => {} }));
  });
  const editor = find(host, (n) => props(n)?.role === 'textbox');
  editor.contains = (node) => node === editor;

  // Browser boundary: the dragged selection, the caret at the drop point, and the range built after the deletion.
  let deleted = 0;
  let dropInsideSource = false;
  const source = { deleteContents: () => { deleted += 1; }, isPointInRange: () => dropInsideSource };
  globalThis.window.getSelection = () => ({ rangeCount: 1, anchorNode: editor, getRangeAt: () => ({ cloneRange: () => source }), removeAllRanges() {}, addRange() {} });
  globalThis.document.caretRangeFromPoint = () => ({ startContainer: editor, startOffset: 0, insertNode() {} });
  globalThis.document.createRange = () => ({ startContainer: editor, setStartBefore() {}, collapse() {} });
  let inserted = '';
  globalThis.document.execCommand = (command, ui, html) => { inserted = html; return true; };
  const createElement = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => Object.assign(createElement(tag), { remove() {} });
  const drop = (extra = {}) => props(editor).onDrop({ preventDefault() {}, clientX: 1, clientY: 1, dataTransfer: { getData: (type) => (type === 'text/html' ? '<b>Beta</b>' : '') }, ...extra });

  await React.act(async () => { props(editor).onDragStart(); drop(); });
  assert.equal(deleted, 1, 'an internal drop removes the dragged source');
  assert.equal(inserted, '<b>Beta</b>', 'the sanitized payload is inserted at the drop point');

  await React.act(async () => { props(editor).onDragStart(); drop({ ctrlKey: true }); });
  assert.equal(deleted, 1, 'Ctrl+drop copies, keeping the source');

  await React.act(async () => { props(editor).onDragStart(); props(editor).onDragEnd(); drop(); });
  assert.equal(deleted, 1, 'a drop after the drag ended is external and removes nothing');

  dropInsideSource = true;
  await React.act(async () => { props(editor).onDragStart(); drop(); });
  assert.equal(deleted, 1, 'dropping onto the dragged text is a no-op');

  await React.act(async () => root.unmount());
});
