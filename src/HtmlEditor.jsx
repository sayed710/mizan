import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';

// Stored HTML is user-editable: keep only structural tags, drop every attribute, and drop script-like elements with their content.
const SAFE_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'B', 'STRONG', 'EM', 'I', 'U', 'BR', 'HR', 'UL', 'OL', 'LI', 'DIV', 'SPAN', 'TABLE', 'CAPTION', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD']);
const KEEP_ATTRS = new Set(['colspan', 'rowspan']);

/** Strip disallowed elements and attributes from a live node's subtree in place, keeping the caret and undo history. */
export function sanitizeInPlace(node) {
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) { child.remove(); continue; }
      clean(child);
      const tag = child.tagName.toUpperCase();
      if (!SAFE_TAGS.has(tag)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH', 'NOSCRIPT'].includes(tag)) child.remove();
        else child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const kept = attr.name === 'class' ? /^[\w\s-]*$/.test(attr.value) : KEEP_ATTRS.has(attr.name) && /^\d{1,3}$/.test(attr.value);
        if (!kept) child.removeAttribute(attr.name);
      }
    }
  };
  clean(node);
  return node;
}

export function sanitizeHtml(html, parse = typeof DOMParser === 'undefined' ? null : (text) => new DOMParser().parseFromString(text, 'text/html')) {
  if (!parse) return null;
  return sanitizeInPlace(parse(String(html ?? '')).body).innerHTML;
}

export function SafeHtml({ html }) {
  const safe = sanitizeHtml(html);
  return safe == null ? <div className="readonly-html">{String(html ?? '')}</div> : <div className="readonly-html" dangerouslySetInnerHTML={{ __html: safe }} />;
}

function findAncestors(editor) {
  let block = null;
  let list = null;
  const sel = window.getSelection?.();
  let curr = sel?.anchorNode;
  if (!curr || (editor && !editor.contains(curr))) return { block, list };
  while (curr && curr !== editor) {
    if (curr.nodeType === 1) {
      const tag = curr.tagName.toLowerCase();
      if (!block && (tag === 'h2' || tag === 'p')) block = curr;
      if (!list && (tag === 'ul' || tag === 'ol')) list = curr;
      if (block && list) break;
    }
    curr = curr.parentNode;
  }
  return { block, list };
}

function escapeTextForHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n|\r|\n/g, '<br>');
}

export function HtmlEditor({ id, label, required, value, placeholder, onChange }) {
  const editorRef = useRef(null);
  const lastEmittedRef = useRef(value ?? '');
  // The selection being dragged inside the editor, so dropping it elsewhere in the editor moves it.
  const dragSourceRef = useRef(null);
  const [content, setContent] = useState(() => sanitizeHtml(value) ?? (value ?? ''));
  const [states, setStates] = useState({
    bold: false,
    italic: false,
    underline: false,
    insertUnorderedList: false,
    insertOrderedList: false,
    h2: false,
    p: false,
  });

  const updateToolbar = () => {
    const queryState = (cmd) => {
      try {
        return Boolean(document.queryCommandState?.(cmd));
      } catch {
        return false;
      }
    };
    const queryVal = (cmd) => {
      try {
        return document.queryCommandValue?.(cmd) || '';
      } catch {
        return '';
      }
    };

    const blockVal = String(queryVal('formatBlock')).toLowerCase();
    const { block, list } = findAncestors(editorRef.current);
    const blockTag = block?.tagName?.toLowerCase();
    const listTag = list?.tagName?.toLowerCase();

    const isH2 = blockVal === 'h2' || blockVal === '<h2>' || blockTag === 'h2';
    const isP = blockVal === 'p' || blockVal === '<p>' || blockTag === 'p';
    const isUl = queryState('insertUnorderedList') || listTag === 'ul';
    const isOl = queryState('insertOrderedList') || listTag === 'ol';

    setStates({
      bold: queryState('bold'),
      italic: queryState('italic'),
      underline: queryState('underline'),
      insertUnorderedList: isUl,
      insertOrderedList: isOl,
      h2: isH2,
      p: isP,
    });
  };

  useEffect(() => {
    updateToolbar();
  }, []);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      lastEmittedRef.current = value ?? '';
      const clean = sanitizeHtml(value) ?? (value ?? '');
      setContent(clean);
      if (editorRef.current) {
        editorRef.current.innerHTML = clean;
      }
      updateToolbar();
    }
  }, [value]);

  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection?.();
      if (editorRef.current?.contains(sel?.anchorNode)) {
        updateToolbar();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const handleInput = () => {
    if (editorRef.current) sanitizeInPlace(editorRef.current);
    const clean = sanitizeHtml(editorRef.current?.innerHTML ?? '') ?? '';
    lastEmittedRef.current = clean;
    onChange?.(clean);
    updateToolbar();
  };

  const exec = (cmd, val = null) => {
    if (document.activeElement && !editorRef.current?.contains(document.activeElement)) {
      editorRef.current?.focus();
    }
    if (cmd === 'formatBlock' && val === '<p>') {
      try {
        if (String(document.queryCommandValue?.('formatBlock')).toLowerCase() === 'p') return;
      } catch { /* ignore */ }
    }
    try {
      document.execCommand(cmd, false, val);
    } catch { /* execCommand fallback */ }
    handleInput();
  };

  const extractCleanPayload = (data) => {
    if (!data) return '';
    const rawHtml = data.getData('text/html');
    const rawText = data.getData('text/plain');
    if (rawHtml) return sanitizeHtml(rawHtml) ?? '';
    if (rawText) return sanitizeHtml(escapeTextForHtml(rawText)) ?? '';
    return '';
  };

  const insertCleanHtml = (clean) => {
    if (!clean) return;

    if (document.execCommand?.('insertHTML', false, clean)) {
      handleInput();
      return;
    }

    const sel = window.getSelection?.();
    if (sel?.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const el = document.createElement('div');
      el.innerHTML = clean;
      const frag = document.createDocumentFragment();
      let node;
      while ((node = el.firstChild)) frag.appendChild(node);
      range.insertNode(frag);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      handleInput();
      return;
    }

    if (editorRef.current) {
      editorRef.current.innerHTML = (editorRef.current.innerHTML || '') + clean;
      handleInput();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const clean = extractCleanPayload(e.clipboardData);
    if (clean) insertCleanHtml(clean);
  };

  const handleDragStart = () => {
    const sel = window.getSelection?.();
    dragSourceRef.current = sel?.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const source = dragSourceRef.current;
    dragSourceRef.current = null;
    const clean = extractCleanPayload(e.dataTransfer);
    if (!clean) return;

    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }

    const inEditor = range && editorRef.current?.contains(range.startContainer);
    if (source && inEditor && !e.ctrlKey && !e.altKey) {
      // Moving within the editor: dropping onto the dragged text is a no-op; otherwise remove the source, keeping the
      // drop point anchored by a marker because the deletion can shift it.
      if (source.isPointInRange(range.startContainer, range.startOffset)) return;
      const marker = document.createElement('span');
      range.insertNode(marker);
      source.deleteContents();
      range = document.createRange();
      range.setStartBefore(marker);
      range.collapse(true);
      marker.remove();
    }

    const sel = window.getSelection?.();
    if (inEditor) {
      sel?.removeAllRanges();
      sel?.addRange(range);
    }

    insertCleanHtml(clean);
  };

  const buttons = [
    {
      key: 'h2',
      label: 'Heading (H2)',
      glyph: <span aria-hidden="true">H2</span>,
      run: () => exec('formatBlock', states.h2 ? '<p>' : '<h2>'),
      pressedKey: 'h2',
    },
    {
      key: 'p',
      label: 'Paragraph',
      glyph: <span aria-hidden="true">¶</span>,
      run: () => exec('formatBlock', '<p>'),
      pressedKey: 'p',
    },
    {
      key: 'bold',
      label: 'Bold',
      glyph: <b aria-hidden="true">B</b>,
      run: () => exec('bold'),
      pressedKey: 'bold',
    },
    {
      key: 'italic',
      label: 'Italic',
      glyph: <i aria-hidden="true">I</i>,
      run: () => exec('italic'),
      pressedKey: 'italic',
    },
    {
      key: 'underline',
      label: 'Underline',
      glyph: <u aria-hidden="true">U</u>,
      run: () => exec('underline'),
      pressedKey: 'underline',
    },
    {
      key: 'ul',
      label: 'Bulleted list',
      glyph: <span aria-hidden="true">•≡</span>,
      run: () => exec('insertUnorderedList'),
      pressedKey: 'insertUnorderedList',
    },
    {
      key: 'ol',
      label: 'Numbered list',
      glyph: <span aria-hidden="true">1≡</span>,
      run: () => exec('insertOrderedList'),
      pressedKey: 'insertOrderedList',
    },
    {
      key: 'undo',
      label: 'Undo',
      glyph: <span aria-hidden="true">↺</span>,
      run: () => exec('undo'),
    },
    {
      key: 'redo',
      label: 'Redo',
      glyph: <span aria-hidden="true">↻</span>,
      run: () => exec('redo'),
    },
  ];

  return (
    <div className="html-editor">
      <div className="html-editor-toolbar" role="toolbar" aria-label={t('Formatting')}>
        {buttons.map(({ key, label, glyph, run, pressedKey }) => {
          const pressed = pressedKey ? Boolean(states[pressedKey]) : undefined;
          return (
            <button
              key={key}
              type="button"
              className={`btn sm${pressed ? ' active' : ''}`}
              aria-label={t(label)}
              aria-pressed={pressed}
              onMouseDown={(e) => e.preventDefault()}
              onClick={run}
            >
              {glyph}
            </button>
          );
        })}
      </div>
      <div
        ref={editorRef}
        id={id}
        className="html-editor-content"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-required={required || undefined}
        data-placeholder={placeholder ?? t('Report content…')}
        dangerouslySetInnerHTML={{ __html: content }}
        onInput={handleInput}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragStart={handleDragStart}
        onDragEnd={() => { dragSourceRef.current = null; }}
        onKeyUp={updateToolbar}
        onMouseUp={updateToolbar}
        onFocus={updateToolbar}
      />
    </div>
  );
}

export default HtmlEditor;
