import { read, search, write } from '../orm.js';
import { nextName, pad, today } from './common.js';
import { salesModels } from './sales.js';

/** Confirm a draft batch transfer, validating its picking lines and assigning a sequence name. */
export function confirmBatch(db, batch) {
  const lines = batch.picking_lines || [];
  if (!lines.length) throw new Error('Batch transfer must contain at least one transfer');
  const pickings = lines.map((l) => {
    const p = read(db, 'stock.picking', l.picking_id);
    if (!p) throw new Error(`Transfer ${l.picking_id} not found`);
    if (p.state === 'done') throw new Error(`Transfer ${p.name || p.id} is already done`);
    return p;
  });
  const types = new Set(pickings.map((p) => p.picking_type));
  if (types.size > 1) throw new Error('Cannot mix incoming and outgoing transfers in one batch');
  const pickingIds = new Set(pickings.map((p) => p.id));
  const otherBatches = search(db, 'stock.picking.batch').filter(
    (b) => b.id !== batch.id && b.state !== 'cancel'
  );
  for (const other of otherBatches) {
    for (const l of other.picking_lines || []) {
      if (pickingIds.has(l.picking_id)) {
        throw new Error(`Transfer ${l.picking_id} is already in another open batch`);
      }
    }
  }
  const name = batch.name && batch.name !== 'New'
    ? batch.name
    : nextName(db, 'stock.picking.batch', 'BATCH/');
  return write(db, 'stock.picking.batch', batch.id, { name, state: 'in_progress' });
}

/** Validate each non-done transfer in a batch in line order and mark the batch done. */
export function validateBatch(db, batch) {
  const validate = salesModels['stock.picking'].form.buttons.find((b) => b.label === 'Validate');
  const done = (batch.picking_lines ?? []).reduce((acc, line) => {
    const picking = read(acc, 'stock.picking', line.picking_id);
    return picking && picking.state !== 'done' ? validate.run(acc, picking).db : acc;
  }, db);
  return write(done, 'stock.picking.batch', batch.id, { state: 'done' });
}

/** Return merged [{ product_id, qty }] contents for a package. */
export function packageContents(db, packageId) {
  const pkg = read(db, 'stock.quant.package', packageId);
  if (!pkg) throw new Error(`Package ${packageId} not found`);
  const totals = new Map();
  for (const line of pkg.content || []) {
    if (!line.product_id) continue;
    totals.set(line.product_id, (totals.get(line.product_id) || 0) + (Number(line.qty) || 0));
  }
  return Array.from(totals, ([product_id, qty]) => ({ product_id, qty }));
}

export const batchModels = {
  'stock.picking.batch': {
    label: 'Batch Transfers',
    fields: {
      name: { type: 'char', label: 'Batch Transfer', required: true },
      user: { type: 'char', label: 'Responsible' },
      scheduled_date: { type: 'date', label: 'Scheduled Date' },
      state: {
        type: 'selection',
        label: 'Status',
        tracking: true,
        options: [
          ['draft', 'Draft'],
          ['in_progress', 'In Progress'],
          ['done', 'Done'],
          ['cancel', 'Cancelled'],
        ],
      },
      picking_lines: {
        type: 'one2many',
        label: 'Transfers',
        fields: {
          picking_id: { type: 'many2one', relation: 'stock.picking', label: 'Transfer' },
        },
        newLine: () => ({ picking_id: null }),
      },
    },
    defaults: () => ({
      name: 'New',
      scheduled_date: today(),
      state: 'draft',
      picking_lines: [],
    }),
    kanban: { title: 'name', lines: ['user', 'scheduled_date'], badge: 'state' },
    list: ['name', 'user', 'scheduled_date', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'done' || r.state === 'cancel',
      buttons: [
        {
          label: 'Confirm',
          primary: true,
          when: (r) => r.state === 'draft',
          run: (db, r) => ({ db: confirmBatch(db, r) }),
        },
        {
          label: 'Validate',
          primary: true,
          when: (r) => r.state === 'in_progress',
          run: (db, r) => ({ db: validateBatch(db, r) }),
        },
        {
          label: 'Cancel',
          when: (r) => r.state !== 'done' && r.state !== 'cancel',
          run: (db, r) => ({ db: write(db, 'stock.picking.batch', r.id, { state: 'cancel' }) }),
        },
      ],
      title: 'name',
      groups: [['user'], ['scheduled_date']],
      tabs: [{ label: 'Transfers', fields: ['picking_lines'] }],
      chatter: true,
    },
  },
  'stock.quant.package': {
    label: 'Packages',
    fields: {
      name: { type: 'char', label: 'Package Reference', required: true },
      package_type: {
        type: 'selection',
        label: 'Package Type',
        options: [
          ['box', 'Box'],
          ['pallet', 'Pallet'],
          ['crate', 'Crate'],
        ],
      },
      weight: { type: 'float', label: 'Weight (kg)' },
      picking_id: { type: 'many2one', relation: 'stock.picking', label: 'Transfer' },
      content: {
        type: 'one2many',
        label: 'Content',
        fields: {
          product_id: { type: 'many2one', relation: 'product', label: 'Product' },
          qty: { type: 'float', label: 'Quantity' },
        },
        newLine: () => ({ product_id: null, qty: 1 }),
      },
    },
    defaults: (id) => ({
      name: `PACK${pad(id, 7)}`,
      package_type: 'box',
      weight: 0,
      picking_id: null,
      content: [],
    }),
    kanban: { title: 'name', lines: ['package_type', 'weight'], badge: 'package_type' },
    list: ['name', 'package_type', 'picking_id', 'weight'],
    form: {
      title: 'name',
      groups: [['package_type', 'weight'], ['picking_id']],
      tabs: [{ label: 'Content', fields: ['content'] }],
      chatter: true,
    },
  },
};
