import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { lockDateFor, moveDeleteGuard } from './models/finance.js';
import { models } from './models/index.js';

// Helpers
const managerCtx = { author: 'Admin', isAdmin: true };
const clerkCtx = { author: 'Clerk', isAdmin: false, login: 'clerk' };
const user3Ctx = { author: 'OtherUser', isAdmin: false, login: 'other' };

const postInvoice = (db, id) => {
  const inv = read(db, 'account.move', id);
  const accounts = search(db, 'account.account');
  const receivable = accounts.find((a) => a.code === '121000')?.id ?? 1;
  const revenue = accounts.find((a) => a.code === '400000')?.id ?? 2;
  const lines = (inv.line_ids && inv.line_ids.length > 0) ? inv.line_ids : [
    { account_id: receivable, debit: 100, credit: 0, partner_id: inv.partner_id },
    { account_id: revenue, debit: 0, credit: 100, partner_id: inv.partner_id },
  ];
  const posted = {
    ...inv,
    state: 'posted',
    name: inv.name && inv.name !== '/' ? inv.name : 'INV/2026/9999',
    line_ids: lines,
  };
  return {
    ...db,
    records: {
      ...db.records,
      'account.move': (db.records['account.move'] ?? []).map((m) => (m.id === id ? posted : m)),
    },
  };
};

// ============================================================================
// JE-8: Draft entries in locked periods
// ============================================================================

test('JE-8: a draft entry dated in a locked period can be re-dated to an open period', () => {
  let db = seed();
  // Create a draft move dated in January 2026
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-01-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draft.db;

  // Lock the company up to 2026-01-31
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Re-date the draft move to February 2026 (open period)
  const reDated = write(db, 'account.move', draft.id, { invoice_date: '2026-02-15' });
  assert.doesNotThrow(() => {
    applyDiff(db, diffDb(db, reDated), clerkCtx);
  });
  const saved = applyDiff(db, diffDb(db, reDated), clerkCtx);
  assert.equal(read(saved, 'account.move', draft.id).invoice_date, '2026-02-15');
});

test('JE-8: a draft entry dated in a locked period can be cancelled', () => {
  let db = seed();
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-01-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draft.db;

  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Cancel the draft entry
  const cancelled = write(db, 'account.move', draft.id, { state: 'cancel' });
  assert.doesNotThrow(() => {
    applyDiff(db, diffDb(db, cancelled), clerkCtx);
  });
  const saved = applyDiff(db, diffDb(db, cancelled), clerkCtx);
  assert.equal(read(saved, 'account.move', draft.id).state, 'cancel');
});

test('JE-8: a draft entry dated in a locked period can be deleted', () => {
  let db = seed();
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-01-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draft.db;

  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  const move = read(db, 'account.move', draft.id);
  assert.equal(moveDeleteGuard(db, move), null);

  assert.doesNotThrow(() => {
    applyDiff(db, { upserts: {}, deletes: { 'account.move': [draft.id] } }, clerkCtx);
  });
});

test('JE-8: a draft entry dated in a locked period is refused when posted', () => {
  let db = seed();
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-01-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draft.db;

  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Trying to post it while still dated in locked period must be refused
  const posted = postInvoice(db, draft.id);
  assert.throws(() => {
    applyDiff(db, diffDb(db, posted), clerkCtx);
  }, /locked/i);
});

test('JE-8: an open draft entry cannot be moved into a locked period', () => {
  let db = seed();
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-02-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draft.db;

  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Moving date from open period (Feb) to locked period (Jan) must be refused
  const moved = {
    ...db,
    records: {
      ...db.records,
      'account.move': (db.records['account.move'] ?? []).map((m) => (m.id === draft.id ? { ...m, invoice_date: '2026-01-15' } : m)),
    },
  };
  assert.throws(() => {
    applyDiff(db, diffDb(db, moved), clerkCtx);
  }, /locked/i);
});

test('JE-8: posted entries in a locked period stay fully protected', () => {
  let db = seed();
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-01-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  // Post it before locking
  const posted = postInvoice(draft.db, draft.id);
  db = applyDiff(draft.db, diffDb(draft.db, posted), managerCtx);

  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Resetting to draft is refused
  const resetDraft = {
    ...db,
    records: {
      ...db.records,
      'account.move': (db.records['account.move'] ?? []).map((m) => (m.id === draft.id ? { ...m, state: 'draft' } : m)),
    },
  };
  assert.throws(() => {
    applyDiff(db, diffDb(db, resetDraft), clerkCtx);
  }, /locked/i);

  // Deleting is refused
  assert.throws(() => {
    applyDiff(db, { upserts: {}, deletes: { 'account.move': [draft.id] } }, clerkCtx);
  }, /locked|cannot be deleted/i);
});

// ============================================================================
// JE-14: Odoo 17+ lock dates on res.company
// ============================================================================

test('JE-14: lockDateFor returns the strictest date that applies to the move', () => {
  const company = {
    lock_date: '2026-01-31',
    tax_lock_date: '2026-03-31',
    sale_lock_date: '2026-04-30',
    purchase_lock_date: '2026-02-28',
    hard_lock_date: '2025-12-31',
  };

  // 1. Sales invoice with tax: sale_lock_date (04-30), tax_lock_date (03-31), global (01-31), hard (2025)
  // Strictest is 2026-04-30
  const saleTaxMove = {
    move_type: 'out_invoice',
    invoice_line_ids: [{ tax_id: 1, price_unit: 100 }],
  };
  assert.equal(lockDateFor(company, saleTaxMove), '2026-04-30');

  // 2. Purchase bill with tax: purchase_lock_date (02-28), tax_lock_date (03-31), global (01-31)
  // Strictest is 2026-03-31
  const purchaseTaxMove = {
    move_type: 'in_invoice',
    invoice_line_ids: [{ tax_id: 1, price_unit: 100 }],
  };
  assert.equal(lockDateFor(company, purchaseTaxMove), '2026-03-31');

  // 3. Purchase bill WITHOUT tax: purchase_lock_date (02-28), global (01-31)
  // Strictest is 2026-02-28
  const purchaseNoTaxMove = {
    move_type: 'in_invoice',
    invoice_line_ids: [{ price_unit: 100, tax: 0 }],
  };
  assert.equal(lockDateFor(company, purchaseNoTaxMove), '2026-02-28');

  // 4. General entry in misc journal without tax: only global (01-31) and hard (2025)
  // Strictest is 2026-01-31
  const miscMove = {
    move_type: 'entry',
    line_ids: [{ account_id: 1, debit: 50 }, { account_id: 2, credit: 50 }],
  };
  assert.equal(lockDateFor(company, miscMove, { type: 'general' }), '2026-01-31');

  // 5. Hard lock date is strictest when it is latest
  const companyHardStrict = {
    ...company,
    hard_lock_date: '2026-06-30',
  };
  assert.equal(lockDateFor(companyHardStrict, miscMove, { type: 'general' }), '2026-06-30');
});

test('JE-14: hard_lock_date cannot be decreased or removed on res.company', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { hard_lock_date: '2026-03-31' });

  // Trying to move hard_lock_date back
  assert.throws(() => {
    applyDiff(db, diffDb(db, write(db, 'res.company', 1, { hard_lock_date: '2026-02-28' })), managerCtx);
  }, /hard lock date cannot be moved back or removed/i);

  // Trying to remove hard_lock_date
  assert.throws(() => {
    applyDiff(db, diffDb(db, write(db, 'res.company', 1, { hard_lock_date: null })), managerCtx);
  }, /hard lock date cannot be moved back or removed/i);
});

test('JE-14: res.company lock_date acts as the Global Lock Date and protects all moves across journals', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Global lock date applies to sales invoice
  const draftSale = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-01-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  assert.throws(() => {
    applyDiff(draftSale.db, diffDb(draftSale.db, postInvoice(draftSale.db, draftSale.id)), clerkCtx);
  }, /locked/i);

  // Global lock date applies to purchase bill
  const draftPurchase = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    invoice_date: '2026-01-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  assert.throws(() => {
    applyDiff(draftPurchase.db, diffDb(draftPurchase.db, postInvoice(draftPurchase.db, draftPurchase.id)), clerkCtx);
  }, /locked/i);
});

// ============================================================================
// JE-15: account.lock_exception
// ============================================================================

test('JE-15: account.lock_exception model is registered and computes state correctly', async () => {
  assert.ok(models['account.lock_exception'], 'account.lock_exception must be registered in models');
  const { exceptionState } = await import('./models/lockexception.js');

  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();

  // Active
  assert.equal(exceptionState({ end_datetime: future }), 'active');

  // Expired
  assert.equal(exceptionState({ end_datetime: past }), 'expired');

  // Revoked
  assert.equal(exceptionState({ end_datetime: future, revoked: true }), 'revoked');
});

test('JE-15: only accounting managers can create or revoke lock exceptions', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });

  const { createLockException, revokeLockException } = await import('./models/lockexception.js');

  const future = new Date(Date.now() + 86400000).toISOString();
  const exceptionVals = {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Auditor review',
  };

  const next = createLockException(db, exceptionVals);

  // Clerk (non-manager) is rejected
  assert.throws(() => {
    applyDiff(db, diffDb(db, next), clerkCtx);
  }, /Only accounting managers create or revoke exceptions/i);

  // Manager is accepted
  const saved = applyDiff(db, diffDb(db, next), managerCtx);
  const createdEx = search(saved, 'account.lock_exception')[0];
  assert.ok(createdEx, 'Lock exception created');
  assert.equal(createdEx.lock_field, 'global');
  assert.equal(createdEx.lock_date, '2026-01-31');

  // Clerk cannot revoke it
  const revokedNext = revokeLockException(saved, createdEx.id);
  assert.throws(() => {
    applyDiff(saved, diffDb(saved, revokedNext), clerkCtx);
  }, /Only accounting managers create or revoke exceptions/i);

  // Manager can revoke it
  const revokedSaved = applyDiff(saved, diffDb(saved, revokedNext), managerCtx);
  const exRecord = read(revokedSaved, 'account.lock_exception', createdEx.id);
  assert.equal(models['account.lock_exception'].fields.state.compute(exRecord), 'revoked');
});

test('JE-15: an exception cannot relax hard_lock_date', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { hard_lock_date: '2026-01-31' });

  const { createLockException } = await import('./models/lockexception.js');
  const future = new Date(Date.now() + 86400000).toISOString();

  assert.throws(() => {
    applyDiff(db, diffDb(db, createLockException(db, {
      company_id: 1,
      lock_field: 'hard',
      lock_date: '2025-12-31',
      end_datetime: future,
      reason: 'Bypass hard lock',
    })), managerCtx);
  }, /Select a lock date field/i);
});

test('JE-15: exception date must be earlier than the current lock date', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  const { createLockException } = await import('./models/lockexception.js');
  const future = new Date(Date.now() + 86400000).toISOString();

  // Trying to set an exception date LATER than or equal to the current lock date
  assert.throws(() => {
    applyDiff(db, diffDb(db, createLockException(db, {
      company_id: 1,
      lock_field: 'global',
      lock_date: '2026-02-28',
      end_datetime: future,
      reason: 'Invalid exception',
    })), managerCtx);
  }, /earlier/i);
});

test('JE-15: active exception replaces lock date for the designated user', async () => {
  let db = seed();
  db = write(db, 'hr.employee', 2, { user_login: 'clerk' });
  db = write(db, 'hr.employee', 3, { user_login: 'other' });
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });

  const { createLockException } = await import('./models/lockexception.js');
  const future = new Date(Date.now() + 86400000).toISOString();

  // Add an exception for user 2 (clerk) relaxing global lock_date to 2026-01-31
  db = createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Late adjustment',
  });

  // Draft move dated 2026-02-15
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-02-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draft.db;

  // 1. User 2 (clerkCtx, login: 'clerk', employee 2) CAN post this move because the exception relaxed the lock to 2026-01-31
  const postedClerk = postInvoice(db, draft.id);
  assert.doesNotThrow(() => {
    applyDiff(db, diffDb(db, postedClerk), clerkCtx);
  });

  // 2. User 3 (user3Ctx, login: 'other', employee 3) CANNOT post this move because the exception does not apply to them
  assert.throws(() => {
    applyDiff(db, diffDb(db, postedClerk), user3Ctx);
  }, /locked/i);

  // 3. User 2 CANNOT post a move dated 2026-01-10 (still locked by the exception date 2026-01-31)
  const earlierDraft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-01-10',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const postedEarlier = postInvoice(earlierDraft.db, earlierDraft.id);
  assert.throws(() => {
    applyDiff(earlierDraft.db, diffDb(earlierDraft.db, postedEarlier), clerkCtx);
  }, /locked/i);
});

test('JE-15: active exception for everyone (empty user_id) applies to all users', async () => {
  let db = seed();
  db = write(db, 'hr.employee', 2, { user_login: 'clerk' });
  db = write(db, 'hr.employee', 3, { user_login: 'other' });
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });

  const { createLockException } = await import('./models/lockexception.js');
  const future = new Date(Date.now() + 86400000).toISOString();

  // Exception with empty user_id relaxes global to 2026-01-31 for everyone
  db = createLockException(db, {
    company_id: 1,
    user_id: null,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Company-wide audit',
  });

  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-02-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draft.db;

  const posted = postInvoice(db, draft.id);
  // Both user 2 and user 3 can post
  assert.doesNotThrow(() => {
    applyDiff(db, diffDb(db, posted), clerkCtx);
  });
  assert.doesNotThrow(() => {
    applyDiff(db, diffDb(db, posted), user3Ctx);
  });
});

test('JE-15: hard_lock_date cannot be bypassed by any exception', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    lock_date: '2026-03-31',
    hard_lock_date: '2026-02-28',
  });

  const { createLockException } = await import('./models/lockexception.js');
  const future = new Date(Date.now() + 86400000).toISOString();

  // Relax global lock_date to 2026-01-31
  db = createLockException(db, {
    company_id: 1,
    user_id: null,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Relax global lock',
  });

  // Try to post on 2026-02-15: later than 01-31, but on or before hard_lock_date (02-28)
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-02-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });

  const posted = postInvoice(draft.db, draft.id);
  assert.throws(() => {
    applyDiff(draft.db, diffDb(draft.db, posted), clerkCtx);
  }, /locked/i);
});

test('JE-15: revoking an exception immediately restores the strict lock', async () => {
  let db = seed();
  db = write(db, 'hr.employee', 2, { user_login: 'clerk' });
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });

  const { createLockException, revokeLockException } = await import('./models/lockexception.js');
  const future = new Date(Date.now() + 86400000).toISOString();

  db = createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Temporary fix',
  });

  const ex = search(db, 'account.lock_exception')[0];
  db = revokeLockException(db, ex.id);

  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-02-15',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });

  const posted = postInvoice(draft.db, draft.id);
  assert.throws(() => {
    applyDiff(draft.db, diffDb(draft.db, posted), clerkCtx);
  }, /locked/i);
});

function setupDom() {
  const makeEl = (tag = 'div') => {
    const node = Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      childNodes: [],
      style: {},
      options: [],
      ownerDocument: globalThis.document,
      appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
      removeChild(child) {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        child.parentNode = null;
        return child;
      },
      insertBefore(child, before) {
        const idx = this.childNodes.indexOf(before);
        if (idx >= 0) this.childNodes.splice(idx, 0, child);
        else this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      setAttribute(name, value) { this[name] = String(value); },
      removeAttribute(name) { delete this[name]; },
      contains(child) { return child === this || this.childNodes.some((c) => c.contains?.(child)); },
      closest(selector) {
        let cur = this;
        const targetTag = selector.toUpperCase();
        while (cur && cur.nodeType === 1) {
          if (cur.tagName === targetTag) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      dispatchEvent(event) {
        let cur = this;
        let canceled = false;
        Object.defineProperty(event, 'target', { value: this, configurable: true });
        while (cur) {
          Object.defineProperty(event, 'currentTarget', { value: cur, configurable: true });
          const ok = EventTarget.prototype.dispatchEvent.call(cur, event);
          if (!ok) canceled = true;
          if (!event.bubbles || event.cancelBubble) break;
          cur = cur.parentNode;
        }
        return !canceled;
      },
      focus() { document.activeElement = this; },
      querySelector(selector) {
        return find(this, (n) => {
          if (selector === '[role=dialog]' || selector === 'form[role=dialog]') return n.role === 'dialog';
          if (selector === '[role=alert]' || selector === '.alert') return n.role === 'alert' || n.className === 'alert';
          if (selector === 'h2' || selector === '#wizard-title') return n.tagName === 'H2' || n.id === 'wizard-title';
          if (selector.startsWith('#')) return n.id === selector.slice(1);
          return false;
        });
      },
      querySelectorAll(selector) {
        return findAll(this, (n) => {
          if (selector === 'input, select, textarea, button') return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(n.tagName);
          return false;
        });
      },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); },
      set(value) { this.childNodes = value ? [{ nodeType: 3, nodeValue: String(value) }] : []; },
    });
    return node;
  };
  globalThis.window = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, scrollTo() {} });
  globalThis.document = Object.assign(new EventTarget(), {
    nodeType: 9,
    nodeName: '#document',
    visibilityState: 'hidden',
    documentElement: makeEl('html'),
    createElement: makeEl,
    createElementNS: (namespace, tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    createComment: () => ({ nodeType: 8 }),
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return makeEl('div');
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) {
    findAll(child, predicate, out);
  }
  return out;
}

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('JE-15: LockDates.jsx lists active exceptions and lets a manager add and revoke exceptions', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LockDates } = await import('./views/LockDates.jsx');
  const { createLockException } = await import('./models/lockexception.js');
  const { initStore, commit, getDb } = await import('./store.js');

  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });
  const future = new Date(Date.now() + 86400000).toISOString();
  db = createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Initial exception',
  });
  await initStore();
  await commit(db);

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db: getDb(), companyId: 1 }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM' && n.role === 'dialog');
    assert.ok(dialog, 'Dialog rendered');

    // Verify active exception is listed
    assert.ok(find(dialog, (n) => n.textContent?.includes('Initial exception')), 'Lists initial exception reason');
    assert.ok(find(dialog, (n) => n.textContent?.includes('2026-01-31')), 'Lists exception date');

    // Add another exception
    const fieldSelect = find(dialog, (n) => n.id === 'ex-field');
    const dateInput = find(dialog, (n) => n.id === 'ex-date');
    const expiryInput = find(dialog, (n) => n.id === 'ex-expiry');
    const reasonInput = find(dialog, (n) => n.id === 'ex-reason');
    const addBtn = find(dialog, (n) => n.id === 'btn-add-exception');

    assert.ok(addBtn, 'Add Exception button exists for manager');

    await React.act(async () => {
      props(fieldSelect).onChange({ target: { value: 'tax' } });
      props(dateInput).onChange({ target: { value: '2026-01-15' } });
      props(expiryInput).onChange({ target: { value: '2026-12-31' } });
      props(reasonInput).onChange({ target: { value: 'Tax audit extension' } });
    });

    await React.act(async () => {
      props(addBtn).onClick();
    });

    const updatedDb = getDb();
    const exceptions = search(updatedDb, 'account.lock_exception');
    assert.equal(exceptions.length, 2, 'New exception was added');
    const taxEx = exceptions.find((x) => x.lock_field === 'tax');
    assert.ok(taxEx, 'Tax exception added');
    assert.equal(taxEx.lock_date, '2026-01-15');

    // Revoke the first exception
    const revokeBtn = find(dialog, (n) => n.tagName === 'BUTTON' && n.textContent === 'Revoke');
    assert.ok(revokeBtn, 'Revoke button exists');
    await React.act(async () => {
      props(revokeBtn).onClick();
    });

    const finalDb = getDb();
    const revoked = read(finalDb, 'account.lock_exception', exceptions[0].id);
    assert.equal(models['account.lock_exception'].fields.state.compute(revoked), 'revoked');
  } finally {
    await React.act(async () => root.unmount());
  }
});
