import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));

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
            if (this.parent) {
              const idx = this.parent.childNodes.indexOf(this);
              if (idx >= 0) this.parent.childNodes.splice(idx, 1);
            }
          },
          replaceWith(...nodes) {
            if (this.parent) {
              const idx = this.parent.childNodes.indexOf(this);
              if (idx >= 0) this.parent.childNodes.splice(idx, 1, ...nodes);
              for (const n of nodes) n.parent = this.parent;
            }
          },
          get innerHTML() {
            return this.childNodes
              .map((c) => (c.nodeType === 3 ? c.nodeValue : `<${c.tagName.toLowerCase()}${c.attributes.length ? ' ' + c.attributes.map((a) => `${a.name}="${a.value}"`).join(' ') : ''}>${c.innerHTML}</${c.tagName.toLowerCase()}>`))
              .join('');
          },
        };
        for (const child of children) child.parent = node;
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

test('fallback to textarea when sanitizeHtml is unavailable (no DOMParser)', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { FieldInput } = await import('./ui.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  delete globalThis.DOMParser;

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  let updatedValue = null;
  await React.act(async () => {
    root.render(React.createElement(FieldInput, {
      field: { type: 'html', label: 'Body' },
      value: '<p>Initial</p>',
      id: 'f-body',
      onChange: (v) => { updatedValue = v; },
    }));
  });

  const textarea = find(host, (n) => n.tagName === 'TEXTAREA');
  assert.ok(textarea, 'textarea fallback rendered when DOMParser unavailable');
  assert.equal(props(textarea)['aria-label'], 'Body');
  assert.equal(props(textarea).id, 'f-body');
  assert.equal(props(textarea).value, '<p>Initial</p>');

  await React.act(async () => {
    props(textarea).onChange({ target: { value: '<p>Fallback edit</p>' } });
  });
  assert.equal(updatedValue, '<p>Fallback edit</p>');

  await React.act(async () => root.unmount());
});

test('rich-text editor renders toolbar buttons, pressed states, and contentEditable textbox with field label', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { FieldInput } = await import('./ui.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  globalThis.DOMParser = createMockDomParser();

  const commands = [];
  globalThis.document.execCommand = (cmd, _, val) => {
    commands.push({ cmd, val });
    return true;
  };
  globalThis.document.queryCommandState = (cmd) => cmd === 'bold';
  globalThis.document.queryCommandValue = (cmd) => (cmd === 'formatBlock' ? 'h2' : '');

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  await React.act(async () => {
    root.render(React.createElement(FieldInput, {
      field: { type: 'html', label: 'Annual Report Body', required: true },
      value: '<h2>Section 1</h2><p>Content</p>',
      id: 'f-report-body',
      onChange: () => {},
    }));
  });

  // Verify toolbar
  const toolbar = find(host, (n) => props(n)?.role === 'toolbar');
  assert.ok(toolbar, 'toolbar exists');

  // Verify all 9 toolbar buttons and their aria-labels
  const buttonLabels = [
    'Heading (H2)',
    'Paragraph',
    'Bold',
    'Italic',
    'Underline',
    'Bulleted list',
    'Numbered list',
    'Undo',
    'Redo',
  ];

  for (const label of buttonLabels) {
    const btn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === label);
    assert.ok(btn, `Toolbar button "${label}" exists`);
  }

  // Check pressed state on toggle buttons
  const boldBtn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Bold');
  assert.equal(props(boldBtn)['aria-pressed'], true, 'Bold button has aria-pressed=true');

  const italicBtn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Italic');
  assert.equal(props(italicBtn)['aria-pressed'], false, 'Italic button has aria-pressed=false');

  const h2Btn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Heading (H2)');
  assert.equal(props(h2Btn)['aria-pressed'], true, 'Heading (H2) has aria-pressed=true when h2 is active');

  // Undo and Redo must NOT have aria-pressed
  const undoBtn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Undo');
  assert.equal(props(undoBtn)['aria-pressed'], undefined, 'Undo button must not have aria-pressed');

  const redoBtn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Redo');
  assert.equal(props(redoBtn)['aria-pressed'], undefined, 'Redo button must not have aria-pressed');

  // Verify contentEditable editor attributes
  const editor = find(host, (n) => props(n)?.role === 'textbox');
  assert.ok(editor, 'contentEditable editor element found');
  assert.equal(props(editor)['aria-multiline'], 'true');
  assert.equal(props(editor)['aria-label'], 'Annual Report Body');
  assert.equal(props(editor).id, 'f-report-body');
  assert.equal(props(editor)['aria-required'], true);
  assert.equal(props(editor).contentEditable, true);

  // Test button click execution
  commands.length = 0;
  await React.act(async () => {
    props(italicBtn).onClick();
  });
  assert.ok(commands.some((c) => c.cmd === 'italic'), 'italic button executes italic command');

  await React.act(async () => {
    props(undoBtn).onClick();
  });
  assert.ok(commands.some((c) => c.cmd === 'undo'), 'undo button executes undo command');

  await React.act(async () => {
    props(redoBtn).onClick();
  });
  assert.ok(commands.some((c) => c.cmd === 'redo'), 'redo button executes redo command');

  await React.act(async () => root.unmount());
});

test('rich-text editor input and paste sanitization, and caret stability', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { HtmlEditor } = await import('./ui.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  globalThis.DOMParser = createMockDomParser();

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  let emitted = null;
  const Wrapper = ({ val }) => (
    React.createElement(HtmlEditor, {
      id: 'f-test',
      label: 'Test Body',
      value: val,
      onChange: (v) => { emitted = v; },
    })
  );

  await React.act(async () => {
    root.render(React.createElement(Wrapper, { val: '<p>Initial text</p>' }));
  });

  const editor = find(host, (n) => props(n)?.role === 'textbox');
  assert.ok(editor, 'Editor found');

  // 1. Input sanitization: unsafe tags (script, onclick) stripped
  await React.act(async () => {
    editor.innerHTML = '<h2>Title</h2><script>alert("xss")</script><p onclick="steal()">Safe paragraph</p>';
    props(editor).onInput();
  });
  assert.ok(emitted, 'onInput called onChange');
  assert.ok(!emitted.includes('script'), 'script tag stripped on input');
  assert.ok(!emitted.includes('alert'), 'script contents removed');
  assert.ok(!emitted.includes('onclick'), 'onclick attribute removed');
  assert.ok(emitted.includes('<h2>Title</h2>'), 'structural tags preserved');
  assert.ok(emitted.includes('<p>Safe paragraph</p>'), 'paragraph preserved');

  // 2. Caret stability: re-rendering with the emitted value does not overwrite innerHTML
  const beforeRenderHTML = editor.innerHTML;
  await React.act(async () => {
    root.render(React.createElement(Wrapper, { val: emitted }));
  });
  assert.equal(editor.innerHTML, beforeRenderHTML, 'innerHTML not reset when incoming value matches last emitted');

  // 3. External sync: changing to a different value does update innerHTML
  await React.act(async () => {
    root.render(React.createElement(Wrapper, { val: '<h2>External Reset</h2><p>New content</p>' }));
  });
  assert.ok(editor.innerHTML.includes('External Reset'), 'innerHTML updated on external value change');

  // 4. Paste event sanitization
  const clipboardMock = {
    getData: (type) => (type === 'text/html' ? '<script>evil()</script><b>Bold pasted text</b>' : ''),
  };
  await React.act(async () => {
    props(editor).onPaste({
      preventDefault: () => {},
      clipboardData: clipboardMock,
    });
  });
  assert.ok(!emitted.includes('script'), 'pasted script tag stripped');
  assert.ok(emitted.includes('<b>Bold pasted text</b>'), 'pasted sanitized structural HTML inserted');

  // 5. Plain text paste escaping and newline conversion
  const plainClipboardMock = {
    getData: (type) => (type === 'text/plain' ? 'Plain line 1\n<script>alert("xss")</script> & "quotes"\r\nPlain line 2' : ''),
  };
  await React.act(async () => {
    props(editor).onPaste({
      preventDefault: () => {},
      clipboardData: plainClipboardMock,
    });
  });
  assert.ok(emitted.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), 'plain text tags are escaped not stripped');
  assert.ok(emitted.includes('Plain line 1<br'), 'newlines converted to <br>');
  assert.ok(emitted.includes('<br></br>Plain line 2') || emitted.includes('<br>Plain line 2'), 'crlf converted to <br>');

  await React.act(async () => root.unmount());
});

test('public form path editing and saving with rich-text editor', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  const { menusFor } = await import('./models/index.js');
  const { FormView } = await import('./views/FormView.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  globalThis.DOMParser = createMockDomParser();

  await initStore();
  seed();

  const menus = menusFor('accounting');
  const review = menus.find((m) => m.label === 'Review');
  const auditMenu = review.children.find((m) => m.label === 'Audit');
  const arLeaf = auditMenu.children.find((m) => m.key === 'annual-report');

  const rep = create(getDb(), 'audit.report', {
    title: 'Rich Text Annual Report',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
    body: '<h2>Initial Report</h2><p>Draft balance</p>',
  });
  commit(rep.db);

  const hostForm = makeEl('div');
  hostForm.ownerDocument = globalThis.document;
  const rootForm = createRoot(hostForm);

  try {
    await React.act(async () => {
      rootForm.render(React.createElement(FormView, {
        leaf: arLeaf,
        id: rep.id,
        base: '#/accounting/annual-report',
        params: new URLSearchParams(),
      }));
    });

    // Editor rendered with role="textbox"
    const editor = find(hostForm, (n) => props(n)?.role === 'textbox' && props(n)?.['aria-label'] === 'Body');
    assert.ok(editor, 'Rich text editor rendered in FormView');

    // Simulate rich text editing with formatting
    await React.act(async () => {
      editor.innerHTML = '<h2>Final Audited Report</h2><p>All ledger entries checked and approved.</p>';
      props(editor).onInput();
    });

    const saveBtn = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Save');
    assert.ok(saveBtn, 'Save button visible after rich text edit');

    await React.act(async () => {
      await props(saveBtn).onClick();
    });

    const savedReport = read(getDb(), 'audit.report', rep.id);
    assert.equal(savedReport.body, '<h2>Final Audited Report</h2><p>All ledger entries checked and approved.</p>');
  } finally {
    await React.act(async () => rootForm.unmount());
  }
});
