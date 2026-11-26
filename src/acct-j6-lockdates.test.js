import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { accountingDateForPost, deduceSequenceNumberReset, lockDateFor, moveDeleteGuard } from './models/finance.js';
import { postMove } from './models/accounting.js';
import { reconcileWith } from './models/bank.js';
import { createCompany } from './models/company.js';
import { addDays, shiftMonth, today } from './models/common.js';
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
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31', tax_lock_date: '2026-03-31' });
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

    const dialog = find(container, (n) => n.role === 'dialog');
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

// ============================================================================
// Qodo PR #187 Review Bug Fixes (1-10)
// ============================================================================

test('Qodo #1: end_datetime rejects invalid time suffixes on create and update, fails closed, and expires AT end instant', async () => {
  const { createLockException, exceptionState } = await import('./models/lockexception.js');
  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });
  const future = new Date(Date.now() + 86400000).toISOString();

  // Fail closed on missing/unparseable end_datetime and expire AT exact instant
  assert.equal(exceptionState({ end_datetime: null }), 'expired');
  assert.equal(exceptionState({ end_datetime: '2026-12-31T99:99:99Z' }), 'expired');
  assert.equal(exceptionState({ end_datetime: '2026-12-31garbage' }), 'expired');
  assert.equal(exceptionState({ end_datetime: '2026-06-01T12:00:00Z' }, new Date('2026-06-01T12:00:00Z')), 'expired');
  assert.equal(exceptionState({ end_datetime: '2026-06-01T12:00:00Z' }, new Date('2026-06-01T11:59:59.999Z')), 'active');

  // Create rejects valid date prefix with invalid time/suffix via ORM and sync diff
  for (const bad of ['2026-12-31T99:99:99Z', '2026-12-31-bad', '2026-02-30T12:00:00Z', '2026-12-31']) {
    assert.throws(() => createLockException(db, {
      company_id: 1,
      lock_field: 'global',
      lock_date: '2026-01-31',
      end_datetime: bad,
      reason: 'Bad expiry',
    }), /expiry date/i);
    const forged = {
      ...db,
      records: {
        ...db.records,
        'account.lock_exception': [...(db.records['account.lock_exception'] ?? []), {
          id: 9901,
          company_id: 1,
          user_id: null,
          lock_field: 'global',
          lock_date: '2026-01-31',
          end_datetime: bad,
          reason: 'Forged expiry',
          revoked: false,
        }],
      },
    };
    assert.throws(() => applyDiff(db, diffDb(db, forged), managerCtx), /expiry date|end_datetime/i);
  }

  // Update rejects unparseable end_datetime via ORM and sync diff
  const validDb = applyDiff(db, diffDb(db, createLockException(db, {
    company_id: 1,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Valid',
  })), managerCtx);
  const ex = search(validDb, 'account.lock_exception')[0];
  assert.throws(() => write(validDb, 'account.lock_exception', ex.id, { end_datetime: '2026-12-31T25:00:00Z' }), /expiry date|end_datetime/i);
  const forgedUpdate = {
    ...validDb,
    records: {
      ...validDb.records,
      'account.lock_exception': validDb.records['account.lock_exception'].map((r) => (
        r.id === ex.id ? { ...r, end_datetime: '2026-12-31T25:00:00Z' } : r
      )),
    },
  };
  assert.throws(() => applyDiff(validDb, diffDb(validDb, forgedUpdate), managerCtx), /expiry date|end_datetime/i);
});

test('Qodo #2: exceptions require a configured target lock and effectiveCompanyLockDates never creates a lock on an unset field', async () => {
  const { createLockException, effectiveCompanyLockDates } = await import('./models/lockexception.js');
  let db = seed();
  const future = new Date(Date.now() + 86400000).toISOString();

  // Creating global exception with unset lock_date fails
  assert.throws(() => applyDiff(db, diffDb(db, createLockException(db, {
    company_id: 1,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
  })), managerCtx), /not set/i);

  // Creating per-type exceptions with unset target locks fails
  for (const field of ['sale', 'purchase', 'tax']) {
    assert.throws(() => applyDiff(db, diffDb(db, createLockException(db, {
      company_id: 1,
      lock_field: field,
      lock_date: '2026-01-31',
      end_datetime: future,
    })), managerCtx), /not set/i);
  }

  // Even if an exception exists after a company lock is later cleared, effectiveCompanyLockDates leaves it unset
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31', sale_lock_date: '2026-03-31' });
  db = createLockException(db, { company_id: 1, lock_field: 'global', lock_date: '2026-01-31', end_datetime: future });
  db = createLockException(db, { company_id: 1, lock_field: 'sale', lock_date: '2026-01-31', end_datetime: future });
  db = write(db, 'res.company', 1, { lock_date: null, sale_lock_date: null });

  const effective = effectiveCompanyLockDates(read(db, 'res.company', 1), db, managerCtx);
  assert.equal(effective.lock_date, null);
  assert.equal(effective.sale_lock_date, null);
});

test('Qodo #3 & #10: LockDates.jsx keeps exceptions outside lock <form>, handles Enter cleanly, and traps Tab/Shift+Tab focus', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LockDates } = await import('./views/LockDates.jsx');
  const { initStore, commit, getDb } = await import('./store.js');

  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31', tax_lock_date: '2026-03-31' });
  await initStore();
  await commit(db);

  let closed = false;
  let saved = false;
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, {
        db: getDb(),
        companyId: 1,
        onClose: () => { closed = true; },
        onSave: () => { saved = true; },
      }));
    });

    const dialog = find(container, (n) => n.role === 'dialog');
    const lockForm = find(dialog, (n) => n.tagName === 'FORM');
    const hasCls = (n, cls) => String(n.class ?? n.className ?? '').split(/\s+/).includes(cls);
    const exSection = find(dialog, (n) => hasCls(n, 'lock-exceptions-section'));
    assert.ok(lockForm && exSection, 'Both lock form and exceptions section render');
    assert.equal(lockForm.contains(exSection), false, 'Exceptions section is kept outside the lock-date <form>');

    // Qodo #3: Pressing Enter in exception inputs adds the exception instead of closing the dialog
    const fieldSelect = find(dialog, (n) => n.id === 'ex-field');
    const dateInput = find(dialog, (n) => n.id === 'ex-date');
    const expiryInput = find(dialog, (n) => n.id === 'ex-expiry');
    const reasonInput = find(dialog, (n) => n.id === 'ex-reason');
    const addBox = find(dialog, (n) => hasCls(n, 'add-exception-box'));

    await React.act(async () => {
      props(fieldSelect).onChange({ target: { value: 'global' } });
      props(dateInput).onChange({ target: { value: '2026-01-31' } });
      props(expiryInput).onChange({ target: { value: '2026-12-31' } });
      props(reasonInput).onChange({ target: { value: 'Enter key addition' } });
    });

    let prevented = false;
    await React.act(async () => {
      props(addBox).onKeyDown({
        key: 'Enter',
        target: reasonInput,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => {},
      });
    });

    assert.equal(prevented, true, 'Enter in exception input prevents default');
    assert.equal(closed, false, 'Enter in exception input does not close dialog');
    assert.equal(saved, false, 'Enter in exception input does not submit lock-date form');
    assert.equal(search(getDb(), 'account.lock_exception').length, 1, 'Enter added the exception');

    // Qodo #10: Tab / Shift+Tab stays trapped inside the dialog
    const focusable = [...dialog.querySelectorAll('input, select, textarea, button')].filter((el) => !el.disabled);
    assert.ok(focusable.length >= 2);
    const first = focusable[0];
    const last = focusable.at(-1);

    first.focus();
    await React.act(async () => {
      props(dialog).onKeyDown({ key: 'Tab', shiftKey: true, preventDefault: () => {}, stopPropagation: () => {} });
    });
    assert.equal(document.activeElement, last, 'Shift+Tab on first focusable wraps to last');

    last.focus();
    await React.act(async () => {
      props(dialog).onKeyDown({ key: 'Tab', shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
    });
    assert.equal(document.activeElement, first, 'Tab on last focusable wraps to first');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Qodo #4: taxable draft date move into tax-only lock is refused for negative plain tax, positive plain tax, manual tax_ids, and tax_grid_base', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { tax_lock_date: '2026-01-31' });
  const accId = search(db, 'account.account')[0].id;

  const cases = [
    { name: 'negative plain tax', vals: { move_type: 'out_invoice', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: -5 }] } },
    { name: 'positive plain tax', vals: { move_type: 'out_invoice', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 14 }] } },
    { name: 'manual line tax_ids', vals: { move_type: 'entry', line_ids: [{ account_id: accId, debit: 100, credit: 0, tax_ids: [1] }, { account_id: accId, debit: 0, credit: 100 }] } },
    { name: 'manual line tax_grid_base', vals: { move_type: 'entry', line_ids: [{ account_id: accId, debit: 100, credit: 0, tax_grid_base: true }, { account_id: accId, debit: 0, credit: 100 }] } },
  ];

  for (const { name, vals } of cases) {
    const draft = create(db, 'account.move', {
      company_id: 1,
      partner_id: 1,
      invoice_date: '2026-02-15',
      date: '2026-02-15',
      ...vals,
    });
    const moved = {
      ...draft.db,
      records: {
        ...draft.db.records,
        'account.move': draft.db.records['account.move'].map((m) => (m.id === draft.id ? { ...m, invoice_date: '2026-01-15', date: '2026-01-15' } : m)),
      },
    };
    assert.throws(() => applyDiff(draft.db, diffDb(draft.db, moved), clerkCtx), /locked/i, `${name} must hit tax lock`);
  }
});

test('Qodo #5: bank statement guard honors user-specific lock exception for matched employee through applyDiff', async () => {
  const { createLockException } = await import('./models/lockexception.js');
  let db = seed();
  db = write(db, 'hr.employee', 2, { user_login: 'clerk' });
  db = write(db, 'hr.employee', 3, { user_login: 'other' });
  const bankJ = search(db, 'account.journal').find((j) => j.type === 'bank');
  const bankAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash')?.id ?? 1;
  const receivable = search(db, 'account.account').find((a) => a.code === '121000')?.id ?? 1;
  assert.ok(bankJ);

  const bankMove = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    journal_id: bankJ.id,
    invoice_date: '2026-02-15',
    state: 'posted',
    name: 'BNK/2026/0099',
    line_ids: [
      { account_id: bankAcc, debit: 100, credit: 0 },
      { account_id: receivable, debit: 0, credit: 100 },
    ],
  });
  const line = create(bankMove.db, 'account.bank.statement.line', {
    company_id: 1,
    journal_id: bankJ.id,
    date: '2026-02-15',
    payment_ref: 'Bank Wire',
    amount: 100,
    state: 'reconciled',
    move_id: bankMove.id,
    bank_move_id: bankMove.id,
  });
  db = write(line.db, 'res.company', 1, { lock_date: '2026-03-31' });
  db = createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: new Date(Date.now() + 86400000).toISOString(),
  });

  // Update a non-reconciled-freeze guard field that triggers datedLockGuard (active: false)
  const archived = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) => (
        l.id === line.id ? { ...l, active: false } : l
      )),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, archived), user3Ctx), /locked/i);
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, archived), clerkCtx));
});

test('Qodo #6: lockedSettlementInvariant honors user-specific lock exception when settling a locked invoice', async () => {
  const { createLockException } = await import('./models/lockexception.js');
  let db = seed();
  db = write(db, 'hr.employee', 2, { user_login: 'clerk' });
  db = write(db, 'hr.employee', 3, { user_login: 'other' });

  const accounts = search(db, 'account.account');
  const receivable = accounts.find((a) => a.code === '121000')?.id ?? accounts[0].id;
  const revenue = accounts.find((a) => a.code === '400000')?.id ?? accounts[1].id;
  const bankAcc = accounts.find((a) => a.account_type === 'asset_cash')?.id ?? accounts[0].id;

  // Create and post invoice dated 2026-02-10 before locking
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-02-10',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
    line_ids: [
      { account_id: receivable, debit: 100, credit: 0, partner_id: 1 },
      { account_id: revenue, debit: 0, credit: 100, partner_id: 1 },
    ],
    state: 'posted',
    name: 'INV/2026/0010',
    amount_total: 100,
    amount_residual: 100,
    amount_paid: 0,
  });
  db = write(inv.db, 'res.company', 1, { lock_date: '2026-03-31' });
  db = createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: new Date(Date.now() + 86400000).toISOString(),
  });

  // Build diff that books a payment entry dated 2026-02-20 and settles the invoice on 2026-02-20
  const payMoveId = Math.max(0, ...(db.records['account.move'] ?? []).map((m) => m.id)) + 1;
  const miscJ = search(db, 'account.journal').find((j) => j.type === 'general') ?? search(db, 'account.journal')[0];
  const payMove = {
    id: payMoveId,
    move_type: 'entry',
    company_id: 1,
    journal_id: miscJ.id,
    invoice_date: '2026-02-20',
    date: '2026-02-20',
    partner_id: 1,
    state: 'posted',
    name: 'BNK/2026/0010',
    line_ids: [
      { account_id: bankAcc, debit: 100, credit: 0 },
      { account_id: receivable, debit: 0, credit: 100, partner_id: 1 },
    ],
  };
  const settledDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': [
        ...db.records['account.move'].map((m) => (
          m.id === inv.id
            ? {
                ...m,
                amount_paid: 100,
                amount_residual: 0,
                payment_date: '2026-02-20',
                payments: [{ move_id: payMoveId, amount: 100, date: '2026-02-20', company_amount: 100 }],
              }
            : m
        )),
        payMove,
      ],
    },
  };

  const diff = diffDb(db, settledDb);
  assert.throws(() => applyDiff(db, diff, user3Ctx), /locked/i);
  const res = applyDiff(db, diff, clerkCtx);
  assert.equal(read(res, 'account.move', inv.id).amount_paid, 100);
});

test('Qodo #7: payment reset to draft and payment edits honor user-specific lock exception through applyDiff', async () => {
  const { createLockException } = await import('./models/lockexception.js');
  const { resetToDraftError } = await import('./models/pay.js');
  let db = seed();
  db = write(db, 'hr.employee', 2, { user_login: 'clerk' });
  db = write(db, 'hr.employee', 3, { user_login: 'other' });
  const bankJ = search(db, 'account.journal').find((j) => j.type === 'bank');
  const bankAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash')?.id ?? 1;
  const receivable = search(db, 'account.account').find((a) => a.code === '121000')?.id ?? 1;

  const payMove = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    journal_id: bankJ.id,
    invoice_date: '2026-02-15',
    partner_id: 1,
    state: 'posted',
    name: 'PAY/2026/0015',
    line_ids: [
      { account_id: bankAcc, debit: 50, credit: 0, partner_id: 1 },
      { account_id: receivable, debit: 0, credit: 50, partner_id: 1 },
    ],
  });
  const payment = create(payMove.db, 'account.payment', {
    company_id: 1,
    journal_id: bankJ.id,
    date: '2026-02-15',
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 50,
    state: 'posted',
    name: 'PAY/2026/0015',
    move_id: payMove.id,
  });
  db = write(payment.db, 'res.company', 1, { lock_date: '2026-03-31' });
  db = createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: new Date(Date.now() + 86400000).toISOString(),
  });

  // resetToDraftError respects ctx
  assert.match(resetToDraftError(db, read(db, 'account.payment', payment.id), user3Ctx) ?? '', /locked/i);
  assert.equal(resetToDraftError(db, read(db, 'account.payment', payment.id), clerkCtx), null);

  // Payment memo edit & reset to draft via applyDiff
  const editedMemo = {
    ...db,
    records: {
      ...db.records,
      'account.payment': db.records['account.payment'].map((p) => (p.id === payment.id ? { ...p, memo: 'Adjusted memo' } : p)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, editedMemo), user3Ctx), /locked/i);
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, editedMemo), clerkCtx));

  const resetDb = {
    ...db,
    records: {
      ...db.records,
      'account.payment': db.records['account.payment'].map((p) => (p.id === payment.id ? { ...p, state: 'draft', move_id: null } : p)),
      'account.move': db.records['account.move'].map((m) => (m.id === payMove.id ? { ...m, state: 'draft' } : m)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, resetDb), user3Ctx), /locked/i);
  const afterReset = applyDiff(db, diffDb(db, resetDb), clerkCtx);
  assert.equal(read(afterReset, 'account.payment', payment.id).state, 'draft');
});

test('Qodo #8: server-side deletes via applyDiff pass ctx so personal exceptions apply consistently', async () => {
  const { createLockException } = await import('./models/lockexception.js');
  let db = seed();
  db = write(db, 'hr.employee', 2, { user_login: 'clerk' });
  db = write(db, 'hr.employee', 3, { user_login: 'other' });
  const bankJ = search(db, 'account.journal').find((j) => j.type === 'bank');
  const accounts = search(db, 'account.account');
  const receivable = accounts.find((a) => a.code === '121000')?.id ?? accounts[0].id;
  const revenue = accounts.find((a) => a.code === '400000')?.id ?? accounts[1].id;

  const payment = create(db, 'account.payment', {
    company_id: 1,
    journal_id: bankJ.id,
    date: '2026-02-15',
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 75,
    state: 'posted',
    name: 'PAY/2026/0075',
  });
  const postedMove = create(payment.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_date: '2026-02-15',
    partner_id: 1,
    state: 'posted',
    name: 'INV/2026/0075',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 75, tax: 0 }],
    line_ids: [
      { account_id: receivable, debit: 75, credit: 0, partner_id: 1 },
      { account_id: revenue, debit: 0, credit: 75, partner_id: 1 },
    ],
  });
  db = write(postedMove.db, 'res.company', 1, { lock_date: '2026-03-31' });
  db = createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: new Date(Date.now() + 86400000).toISOString(),
  });

  // Payment delete via applyDiff: user3 blocked by lock, clerk succeeds
  const payDel = { upserts: {}, deletes: { 'account.payment': [payment.id] } };
  assert.throws(() => applyDiff(db, payDel, user3Ctx), /locked/i);
  const afterDel = applyDiff(db, payDel, clerkCtx);
  assert.equal(read(afterDel, 'account.payment', payment.id), undefined);

  // Move delete guard receives ctx via applyDiff: user3 gets locked error, clerk bypasses lock check
  const moveDel = { upserts: {}, deletes: { 'account.move': [postedMove.id] } };
  assert.throws(() => applyDiff(db, moveDel, user3Ctx), /period up to 2026-03-31 is locked/i);
  assert.throws(() => applyDiff(db, moveDel, clerkCtx), /Posted entries cannot be deleted/i);
});

test('Qodo #9: non-accounting managers cannot create, edit, revoke, or delete lock exceptions through applyDiff', async () => {
  const { createLockException } = await import('./models/lockexception.js');
  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });
  const future = new Date(Date.now() + 86400000).toISOString();

  const saved = applyDiff(db, diffDb(db, createLockException(db, {
    company_id: 1,
    user_id: 2,
    lock_field: 'global',
    lock_date: '2026-01-31',
    end_datetime: future,
    reason: 'Initial',
  })), managerCtx);
  const ex = search(saved, 'account.lock_exception')[0];

  // Non-admin edit rejected
  const edited = write(saved, 'account.lock_exception', ex.id, { reason: 'Tampered' });
  assert.throws(() => applyDiff(saved, diffDb(saved, edited), clerkCtx), /Only accounting managers/i);

  // Non-admin delete rejected
  assert.throws(() => applyDiff(saved, { upserts: {}, deletes: { 'account.lock_exception': [ex.id] } }, clerkCtx), /Only accounting managers/i);

  // Manager delete allowed
  const afterDel = applyDiff(saved, { upserts: {}, deletes: { 'account.lock_exception': [ex.id] } }, managerCtx);
  assert.equal(read(afterDel, 'account.lock_exception', ex.id), undefined);
});

test('Odoo 20: deduceSequenceNumberReset & accountingDateForPost match _get_accounting_date algorithm', () => {
  assert.equal(deduceSequenceNumberReset(null), 'never');
  assert.equal(deduceSequenceNumberReset('INV/2026/00001'), 'year');
  assert.equal(deduceSequenceNumberReset('INV/2026/02/00001'), 'month');
  assert.equal(deduceSequenceNumberReset('BILL/2025-2026/0001'), 'year_range');
  assert.equal(deduceSequenceNumberReset('BILL/2025-2026/02/0001'), 'year_range_month');
  assert.equal(deduceSequenceNumberReset('INV/0001'), 'never');

  let db = seed();
  // Soft lock up to end of Jan 2026 -> firstOpen = 2026-02-01. Clear existing journal moves to isolate highest_name.
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const billJournal = search(db, 'account.journal').find((j) => j.type === 'purchase' && (j.company_id ?? 1) === 1);
  db = { ...db, records: { ...db.records, 'account.move': [] } };
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  const baseSale = { id: 9001, company_id: 1, move_type: 'out_invoice', journal_id: saleJournal.id, invoice_date: '2026-01-15' };
  const baseBill = { id: 9002, company_id: 1, move_type: 'in_invoice', journal_id: billJournal.id, invoice_date: '2026-01-15' };

  // No highest_name: behaves like monthly reset
  assert.equal(accountingDateForPost(db, baseSale, { todayDate: '2026-03-10' }), '2026-02-28');
  assert.equal(accountingDateForPost(db, baseSale, { todayDate: '2026-02-10' }), '2026-02-10');
  assert.equal(accountingDateForPost(db, baseBill, { todayDate: '2026-03-10' }), '2026-02-28');
  assert.equal(accountingDateForPost(db, baseBill, { todayDate: '2026-02-10' }), '2026-02-10');
  assert.equal(accountingDateForPost(db, baseBill, { todayDate: '2026-01-20' }), '2026-02-01');

  // With yearly sequence existing in journal: yearly reset rule (create posted moves before locking)
  const accounts = search(db, 'account.account');
  const receivable = accounts.find((a) => a.code === '121000' && (a.company_id ?? 1) === 1).id;
  const payable = accounts.find((a) => a.code === '211000' && (a.company_id ?? 1) === 1).id;
  const income = accounts.find((a) => a.code === '400000' && (a.company_id ?? 1) === 1).id;
  const expense = accounts.find((a) => a.code === '600000' && (a.company_id ?? 1) === 1).id;
  db = write(db, 'res.company', 1, { lock_date: null });
  db = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJournal.id,
    partner_id: 1,
    name: 'INV/2026/00001',
    invoice_date: '2026-01-10',
    state: 'posted',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100, tax: 0, account_id: income }],
    line_ids: [
      { account_id: receivable, debit: 100, credit: 0, partner_id: 1 },
      { account_id: income, debit: 0, credit: 100, partner_id: 1 },
    ],
  }).db;
  db = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    journal_id: billJournal.id,
    partner_id: 1,
    name: 'BILL/2026/00001',
    invoice_date: '2026-01-10',
    state: 'posted',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100, tax: 0, account_id: expense }],
    line_ids: [
      { account_id: expense, debit: 100, credit: 0, partner_id: 1 },
      { account_id: payable, debit: 0, credit: 100, partner_id: 1 },
    ],
  }).db;
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });
  assert.equal(accountingDateForPost(db, baseSale, { todayDate: '2026-06-15' }), '2026-06-15');
  assert.equal(accountingDateForPost(db, baseSale, { todayDate: '2027-03-10' }), '2026-12-31');
  assert.equal(accountingDateForPost(db, baseBill, { todayDate: '2026-06-15' }), '2026-06-15');
  assert.equal(accountingDateForPost(db, baseBill, { todayDate: '2027-03-10' }), '2026-12-31');

  // Fixed ('never') sequence returns firstOpen
  assert.equal(accountingDateForPost(db, { ...baseSale, highest_name: 'INV/0001' }, { todayDate: '2026-06-15' }), '2026-02-01');
  assert.equal(accountingDateForPost(db, { ...baseBill, highest_name: 'BILL/0001' }, { todayDate: '2026-06-15' }), '2026-02-01');
});

test('Odoo 20: posting invoices/bills in soft-locked period shifts accounting date, while hard/tax locks and manual entries still block', () => {
  let db = seed();
  const invDate = shiftMonth(today(), -2);
  const softLock = addDays(invDate, 5);
  const firstOpen = addDays(softLock, 1);

  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const billJournal = search(db, 'account.journal').find((j) => j.type === 'purchase' && (j.company_id ?? 1) === 1);
  const incomeAcc = search(db, 'account.account').find((a) => a.code === '400000' && (a.company_id ?? 1) === 1);
  const expAcc = search(db, 'account.account').find((a) => a.code === '600000' && (a.company_id ?? 1) === 1);

  db = write(db, 'res.company', 1, { sale_lock_date: softLock });

  // Sales invoice in soft-locked period shifts date and preserves invoice_date
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJournal.id,
    partner_id: 1,
    invoice_date: invDate,
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 200, account_id: incomeAcc.id, tax: 0 }],
  });
  const afterSalePost = postMove(inv.db, inv.id);
  const postedSale = read(afterSalePost, 'account.move', inv.id);
  assert.equal(postedSale.state, 'posted');
  assert.equal(postedSale.invoice_date, invDate);
  assert.ok(postedSale.date >= firstOpen, `Expected shifted date >= ${firstOpen}, got ${postedSale.date}`);

  // Vendor bill unaffected by sale_lock_date (stays on invDate)
  const billOpen = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    journal_id: billJournal.id,
    partner_id: 1,
    invoice_date: invDate,
    invoice_line_ids: [{ name: 'Supply', qty: 1, price_unit: 150, account_id: expAcc.id, tax: 0 }],
  });
  const postedOpenBill = read(postMove(billOpen.db, billOpen.id), 'account.move', billOpen.id);
  assert.equal(postedOpenBill.date ?? postedOpenBill.invoice_date, invDate);

  // Vendor bill with purchase_lock_date shifts accounting date >= firstOpen
  const billLockedDb = write(db, 'res.company', 1, { purchase_lock_date: softLock });
  const billLocked = create(billLockedDb, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    journal_id: billJournal.id,
    partner_id: 1,
    invoice_date: invDate,
    invoice_line_ids: [{ name: 'Supply Locked', qty: 1, price_unit: 150, account_id: expAcc.id, tax: 0 }],
  });
  const postedBill = read(postMove(billLocked.db, billLocked.id), 'account.move', billLocked.id);
  assert.equal(postedBill.state, 'posted');
  assert.equal(postedBill.invoice_date, invDate);
  assert.ok(postedBill.date >= firstOpen);

  // Tax Return Lock Date blocks taxable invoice hard, does NOT block untaxed invoice when only tax_lock_date is set
  const taxLockedDb = write(seed(), 'res.company', 1, { tax_lock_date: softLock });
  const taxedInv = create(taxLockedDb, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJournal.id,
    partner_id: 1,
    invoice_date: invDate,
    invoice_line_ids: [{ name: 'Taxed', qty: 1, price_unit: 100, tax: 15, account_id: incomeAcc.id }],
  });
  assert.throws(() => postMove(taxedInv.db, taxedInv.id), /period up to .* is locked/i);
  const untaxedInv = create(taxLockedDb, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJournal.id,
    partner_id: 1,
    invoice_date: invDate,
    invoice_line_ids: [{ name: 'Untaxed', qty: 1, price_unit: 100, account_id: incomeAcc.id }],
  });
  const postedUntaxed = read(postMove(untaxedInv.db, untaxedInv.id), 'account.move', untaxedInv.id);
  assert.equal(postedUntaxed.state, 'posted');

  const zeroExportTax = search(taxLockedDb, 'account.tax').find((tax) => tax.name === '0% Exports');
  if (zeroExportTax) {
    const zeroTaxedInv = create(taxLockedDb, 'account.move', {
      move_type: 'out_invoice',
      company_id: 1,
      journal_id: saleJournal.id,
      partner_id: 1,
      invoice_date: invDate,
      invoice_line_ids: [{ name: 'Zero-rated Export', qty: 1, price_unit: 100, tax_id: zeroExportTax.id, tax_name: zeroExportTax.name, tax: 0, account_id: incomeAcc.id }],
    });
    assert.throws(() => postMove(zeroTaxedInv.db, zeroTaxedInv.id), /period up to .* is locked/i);
  }

  // Direct forged applyDiff setting state: 'posted' with locked date still blocks without client shifting
  const forged = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJournal.id,
    partner_id: 1,
    invoice_date: invDate,
    invoice_line_ids: [{ name: 'Forged', qty: 1, price_unit: 100, account_id: incomeAcc.id }],
  });
  const forgedRec = { ...read(forged.db, 'account.move', forged.id), state: 'posted', name: 'INV/2026/7777' };
  assert.throws(() => applyDiff(forged.db, { upserts: { 'account.move': [forgedRec] }, deletes: {} }, managerCtx), /locked/i);

  // Hard lock date blocks invoice posting hard
  const cleanForHard = {
    ...db,
    records: {
      ...db.records,
      'account.move': (db.records['account.move'] ?? []).filter((m) => !(m.state === 'draft' && (m.date ?? m.invoice_date ?? '') <= softLock)),
      'account.bank.statement.line': (db.records['account.bank.statement.line'] ?? []).filter((l) => !(l.state !== 'reconciled' && (l.date ?? '') <= softLock)),
    },
  };
  const hardDb = write(cleanForHard, 'res.company', 1, { hard_lock_date: softLock });
  const hardInv = create(hardDb, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJournal.id,
    partner_id: 1,
    invoice_date: invDate,
    invoice_line_ids: [{ name: 'Hard Locked', qty: 1, price_unit: 100, tax: 0, account_id: incomeAcc.id }],
  });
  assert.throws(() => postMove(hardInv.db, hardInv.id), new RegExp(`The period up to ${softLock} is locked`));
});

test('Odoo 20: setting hard_lock_date validates company draft entries and unreconciled bank lines', async () => {
  let db = seed();
  const pastDate = addDays(today(), -60);
  const lockDate = addDays(today(), -30);

  // Clean any seeded drafts or unreconciled bank lines on or before lockDate
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': (db.records['account.move'] ?? []).filter((m) => !(m.state === 'draft' && (m.date ?? m.invoice_date ?? '') <= lockDate)),
      'account.bank.statement.line': (db.records['account.bank.statement.line'] ?? []).filter((l) => !(l.state !== 'reconciled' && (l.date ?? '') <= lockDate)),
    },
  };

  // 1. Draft entry in period blocks hard_lock_date with Odoo's message
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: pastDate,
    invoice_line_ids: [{ name: 'Draft Item', qty: 1, price_unit: 75, tax: 0 }],
  });
  assert.throws(
    () => write(draftInv.db, 'res.company', 1, { hard_lock_date: lockDate }),
    /There are still draft entries in the period you want to hard lock\. You should either post or delete them\./,
  );

  // Global lock dates do not check draft entries.
  assert.doesNotThrow(() => write(draftInv.db, 'res.company', 1, { lock_date: lockDate }));

  // Posting the draft clears the draft blocker
  db = postMove(draftInv.db, draftInv.id);

  // 2. Unreconciled bank statement line in period blocks hard_lock_date with Odoo's message
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const bankLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    date: pastDate,
    partner_id: 1,
    payment_ref: 'Unreconciled stmt',
    amount: 75,
    state: 'to_check',
  });
  const linkedBankDb = { ...bankLine.db, records: { ...bankLine.db.records, 'account.bank.statement.line': bankLine.db.records['account.bank.statement.line'].map((line) => line.id === bankLine.id ? { ...line, bank_move_id: draftInv.id } : line) } };
  assert.throws(
    () => write(linkedBankDb, 'res.company', 1, { hard_lock_date: lockDate }),
    /There are still unreconciled bank transactions in the period you want to lock\. You should either reconcile or delete them\./,
  );

  assert.throws(
    () => write(linkedBankDb, 'res.company', 1, { lock_date: lockDate }),
    /There are still unreconciled bank transactions/,
  );

  // Reconciling clears the blocker; a branch draft is outside the parent lock scope
  db = reconcileWith(bankLine.db, read(bankLine.db, 'account.bank.statement.line', bankLine.id), draftInv.id);
  const branch = createCompany(db, { name: 'Branch Co', parent_id: 1 });
  db = branch.db;
  const branchDraft = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: branch.id,
    partner_id: 1,
    invoice_date: pastDate,
    invoice_line_ids: [{ name: 'Branch Draft', qty: 1, price_unit: 25, tax: 0 }],
  });
  assert.doesNotThrow(() => write(branchDraft.db, 'res.company', 1, { hard_lock_date: lockDate }));
  assert.throws(() => write(branchDraft.db, 'res.company', branch.id, { hard_lock_date: lockDate }), /There are still draft entries/);

  // Once branch draft is cancelled, parent hard_lock_date succeeds
  db = write(branchDraft.db, 'account.move', branchDraft.id, { state: 'cancel' });
  db = write(db, 'res.company', 1, { hard_lock_date: lockDate });
  assert.equal(read(db, 'res.company', 1).hard_lock_date, lockDate);

  // Labels and Arabic translations
  assert.equal(models['res.company'].fields.lock_date.label, 'Global Lock Date');
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t: arT } = await import(`./i18n.js?lck2-ar=${Date.now()}`);
    assert.notEqual(arT('Global Lock Date'), 'Global Lock Date');
    assert.notEqual(arT('Global Lock Date must be a valid date'), 'Global Lock Date must be a valid date');
    assert.notEqual(arT('There are still draft entries in the period you want to hard lock. You should either post or delete them.'), 'There are still draft entries in the period you want to hard lock. You should either post or delete them.');
    assert.notEqual(arT('There are still unreconciled bank transactions in the period you want to lock. You should either reconcile or delete them.'), 'There are still unreconciled bank transactions in the period you want to lock. You should either reconcile or delete them.');
  } finally {
    globalThis.localStorage = prevLS;
  }
});

test('future sales locks move posting into the first open period', () => {
  let db = seed();
  const lock = addDays(today(), 40);
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  db = write(db, 'res.company', 1, { sale_lock_date: lock });
  const inv = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, journal_id: journal.id, partner_id: 1, invoice_date: today(), invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100 }] });
  assert.equal(read(postMove(inv.db, inv.id), 'account.move', inv.id).date, addDays(lock, 1));
  assert.equal(accountingDateForPost(db, { move_type: 'out_invoice', company_id: 1, journal_id: journal.id, date: today(), highest_name: 'INV/2026/001' }, { todayDate: today() }), addDays(lock, 1));
});

test('unbooked imported bank transactions block company locks', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.bank.statement.line': [] } };
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const line = create(db, 'account.bank.statement.line', { journal_id: journal.id, company_id: 1, date: '2026-01-01', payment_ref: 'Imported', amount: 20, state: 'to_check' });
  assert.ok(!read(line.db, 'account.bank.statement.line', line.id).bank_move_id);
  for (const field of ['lock_date', 'hard_lock_date']) assert.throws(() => write(line.db, 'res.company', 1, { [field]: '2026-01-31' }), /unreconciled bank transactions/);
});

test('zero-rated tax-name-only lines receive the tax lock', () => {
  const company = { tax_lock_date: '2026-12-31' };
  assert.equal(lockDateFor(company, { line_ids: [{ tax_name: '0%', tax_zero: true }] }), '2026-12-31');
  assert.equal(lockDateFor(company, { invoice_line_ids: [{ tax_name: '0%', tax_zero: true }] }), '2026-12-31');
});

test('shifted invoice numbering uses the accounting period for overrides', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  db = write(db, 'account.journal', journal.id, { sequence_override_regex: String.raw`^(?P<prefix1>.*?)(?P<year>\d{4})/(?P<month>\d{2})/(?P<seq>\d+)$` });
  db = write(db, 'res.company', 1, { sale_lock_date: '2027-12-31' });
  db = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], { id: 99999, company_id: 1, journal_id: journal.id, move_type: 'out_invoice', state: 'posted', date: '2027-12-01', invoice_date: '2027-12-01', name: 'INV/2027/12/0001' }] } };
  const inv = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, journal_id: journal.id, partner_id: 1, invoice_date: '2027-12-15', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100 }] });
  const posted = read(postMove(inv.db, inv.id), 'account.move', inv.id);
  assert.equal(posted.date, '2028-01-01');
  assert.match(posted.name, /2028\/01\//);
});
