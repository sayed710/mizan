import { create, read, write } from '../orm.js';
import { commercialPartnerId, total } from './common.js';
import { documentCompany } from './company.js';
import { renderTemplate } from './mailing.js';
import { findCompanyCurrencyRecord, formatCurrency } from '../money.js';
import { LANGUAGES, lang as currentUiLang } from '../i18n.js';

const EMAIL_ADDRESS_RE = /^[^@\s<>,;"]{1,64}@[^@\s<>,;"]{1,190}$/;
export const INVOICE_PDF_REPORTS = [
  ['invoices', 'Invoices'],
  ['invoices_without_payment', 'Invoices without Payment'],
];

export const INVOICE_SEND_TEMPLATE_SPECS = [
  {
    code: 'invoice_sending',
    name: 'Invoice: Sending',
    model: 'account.move',
    subject: '{{ object.company_id.name }} — Invoice {{ object.name }}',
    body: [
      'Dear {{ object.partner_id.name }},',
      '',
      'Please find attached invoice {{ object.name }} for a total amount of {{ object.amount_total }}.',
      'Due date: {{ object.invoice_date_due }}.',
      '',
      'Thank you for your business.',
      '',
      'Best regards,',
      '{{ object.company_id.name }}',
    ].join('\n'),
    subject_ar: '{{ object.company_id.name }} — الفاتورة {{ object.name }}',
    body_ar: [
      'عزيزي {{ object.partner_id.name }}،',
      '',
      'يرجى التكرم بالاطلاع على الفاتورة المرفقة رقم {{ object.name }} بمبلغ إجمالي قدره {{ object.amount_total }}.',
      'تاريخ الاستحقاق: {{ object.invoice_date_due }}.',
      '',
      'نشكركم على تعاملكم معنا.',
      '',
      'مع أطيب التحيات،',
      '{{ object.company_id.name }}',
    ].join('\n'),
    attachments: [],
  },
  {
    code: 'credit_note_sending',
    name: 'Credit Note: Sending',
    model: 'account.move',
    subject: '{{ object.company_id.name }} — Credit Note {{ object.name }}',
    body: [
      'Dear {{ object.partner_id.name }},',
      '',
      'Please find attached credit note {{ object.name }} for a total amount of {{ object.amount_total }}.',
      '',
      'Thank you for your business.',
      '',
      'Best regards,',
      '{{ object.company_id.name }}',
    ].join('\n'),
    subject_ar: '{{ object.company_id.name }} — الإشعار الدائن {{ object.name }}',
    body_ar: [
      'عزيزي {{ object.partner_id.name }}،',
      '',
      'يرجى التكرم بالاطلاع على الإشعار الدائن المرفق رقم {{ object.name }} بمبلغ إجمالي قدره {{ object.amount_total }}.',
      '',
      'نشكركم على تعاملكم معنا.',
      '',
      'مع أطيب التحيات،',
      '{{ object.company_id.name }}',
    ].join('\n'),
    attachments: [],
  },
];

export const isSalesDocument = (r) => Boolean(r && ['out_invoice', 'out_refund', 'out_receipt'].includes(r.move_type));

export function isValidEmailAddress(email) {
  return EMAIL_ADDRESS_RE.test(String(email ?? '').trim());
}

/** Seed default Invoice and Credit Note sending templates if missing. */
export function ensureInvoiceMailTemplates(db) {
  if (!db) return db;
  const existing = db.records?.['mail.template'] ?? [];
  const maxId = Math.max(db.seq?.['mail.template'] ?? 0, 0, ...existing.map((r) => Number(r?.id) || 0));
  let next = {
    ...db,
    records: db.records ?? {},
    seq: maxId > (db.seq?.['mail.template'] ?? 0) ? { ...(db.seq ?? {}), 'mail.template': maxId } : (db.seq ?? {}),
    messages: db.messages ?? [],
  };
  for (const spec of INVOICE_SEND_TEMPLATE_SPECS) {
    const found = (next.records['mail.template'] ?? []).some(
      (t) => t.model === 'account.move' && (t.code === spec.code || t.name === spec.name),
    );
    if (!found) {
      next = create(next, 'mail.template', spec).db;
    }
  }
  return next;
}

export function resolveMoveSelection(db, moveOrIds) {
  if (Array.isArray(moveOrIds)) {
    if (!moveOrIds.length) throw new Error('Select at least one record first');
    return moveOrIds.map((id) => {
      const move = read(db, 'account.move', id);
      if (!move) throw new Error('Journal entry not found');
      return move;
    });
  }
  const move = moveOrIds?.id ? (read(db, 'account.move', moveOrIds.id) ?? moveOrIds) : moveOrIds;
  if (!move) throw new Error('Journal entry not found');
  return [move];
}

export function resolveSendMoves(db, moveOrIds) {
  const moves = resolveMoveSelection(db, moveOrIds);
  if (moves.some((m) => m.state !== 'posted')) {
    throw new Error("You can't generate invoices that are not posted.");
  }
  if (moves.some((m) => !isSalesDocument(m))) {
    throw new Error('You can only generate sales documents or purchase documents for self-billing.');
  }
  return moves;
}

export function moveSendingMethod(db, move) {
  const p = move?.partner_id ? read(db, 'res.partner', move.partner_id) : null;
  if (!p) return null;
  if (p.invoice_sending_method) return p.invoice_sending_method;
  const commId = commercialPartnerId(db, p.id);
  return commId && commId !== p.id ? (read(db, 'res.partner', commId)?.invoice_sending_method ?? null) : null;
}

export function partitionSendMoves(db, moves) {
  const emailTargets = [];
  const manualTargets = [];
  for (const m of moves) {
    const method = moveSendingMethod(db, m);
    if (method !== 'manual') emailTargets.push(m);
    if (method !== 'email') manualTargets.push(m);
  }
  return { emailTargets, manualTargets };
}

/** Find the default mail.template for an invoice or credit note. */
export function defaultInvoiceMailTemplate(db, move) {
  const templates = (db?.records?.['mail.template'] ?? []).filter((t) => !t.model || t.model === 'account.move');
  if (!templates.length) return null;
  const isCreditNote = move?.move_type === 'out_refund';
  const targetCode = isCreditNote ? 'credit_note_sending' : 'invoice_sending';
  const targetName = isCreditNote ? 'Credit Note: Sending' : 'Invoice: Sending';
  return (
    templates.find((t) => t.code === targetCode)
    ?? templates.find((t) => t.name === targetName)
    ?? templates.find((t) => t.model === 'account.move')
    ?? templates[0]
  );
}

/** Build the placeholder context object for rendering a mail.template against an account.move. */
export function moveTemplateContext(db, move) {
  if (!move) return {};
  const partner = move.partner_id ? read(db, 'res.partner', move.partner_id) : null;
  const company = documentCompany(db, move) ?? (move.company_id ? read(db, 'res.company', move.company_id) : null);
  const currency = read(db, 'res.currency', move.currency_id) ?? (company ? findCompanyCurrencyRecord(db, company.id) : null);
  const salesperson = move.invoice_user_id ? read(db, 'hr.employee', move.invoice_user_id) : null;
  const amountTotal = total(move, db);
  const formattedTotal = currency ? formatCurrency(amountTotal, currency) : String(amountTotal);
  const amountResidual = Number(move.amount_residual ?? amountTotal);
  const formattedResidual = currency ? formatCurrency(amountResidual, currency) : String(amountResidual);
  return {
    ...move,
    partner_id: partner ?? {},
    company_id: company ?? {},
    currency_id: currency ?? {},
    invoice_user_id: salesperson ?? {},
    amount_total: formattedTotal,
    amount_residual: formattedResidual,
    amount_total_value: amountTotal,
    amount_residual_value: amountResidual,
  };
}

/** Render a mail.template subject and body for `move` in the requested language. */
export function renderInvoiceMailTemplate(db, template, move, langCode = 'en') {
  if (!template || !move) return { subject: '', body: '' };
  const rawSubject = langCode === 'ar' ? (template.subject_ar || template.subject || '') : (template.subject || '');
  const rawBody = langCode === 'ar' ? (template.body_ar || template.body || '') : (template.body || '');
  const ctx = moveTemplateContext(db, move);
  return {
    subject: renderTemplate(rawSubject, ctx).trim(),
    body: renderTemplate(rawBody, ctx).trim(),
  };
}

/** Build the default generated invoice document attachment descriptor for the Send wizard. */
export function invoicePdfAttachment(move, pdfReportId = 'invoices') {
  const safeName = String(move?.name || `invoice-${move?.id ?? 'doc'}`).replace(/[^A-Za-z0-9._-]+/g, '_');
  return {
    id: `invoice_pdf_${move?.id ?? 'doc'}`,
    kind: 'invoice_pdf',
    name: `${safeName}.pdf`,
    type: 'application/pdf',
    pdf_report_id: pdfReportId || 'invoices',
  };
}

/** Extract attachment descriptors declared on a mail.template. */
export function templateAttachments(template) {
  if (!template || !Array.isArray(template.attachments)) return [];
  return template.attachments
    .filter((att) => att?.file && (att.file.data || att.file.blob))
    .map((att, idx) => ({
      id: `tpl_${template.id}_${idx}`,
      kind: 'template',
      name: String(att.name || att.file.name || `attachment-${idx + 1}`).trim(),
      type: att.file.type || 'application/octet-stream',
      size: Number(att.file.size) || 0,
      ...(att.file.data ? { data: att.file.data } : {}),
      ...(att.file.blob ? { blob: att.file.blob } : {}),
    }));
}

/** Compute alert banners for single-invoice Send wizard (account.move.send.wizard). */
export function singleSendAlerts(db, move, vals = {}) {
  const partnerIds = Array.isArray(vals?.mail_partner_ids)
    ? vals.mail_partner_ids
    : (move?.partner_id ? [move.partner_id] : []);
  if (!partnerIds.length) {
    return [{ level: 'warning', code: 'no_recipient', message: 'No recipient selected.' }];
  }
  const alerts = [];
  for (const pid of partnerIds) {
    const partner = read(db, 'res.partner', Number(pid));
    const email = String(partner?.email ?? '').trim();
    if (!partner || !email) {
      alerts.push({
        level: 'warning',
        code: 'missing_email',
        message: `Partner ${partner?.name ?? `#${pid}`} has no email address.`,
      });
    } else if (!isValidEmailAddress(email)) {
      alerts.push({
        level: 'warning',
        code: 'invalid_email',
        message: `Partner ${partner.name} has an invalid email address.`,
      });
    }
  }
  return alerts;
}

/** Compute per-method sending counts for batch Send wizard (account.move.send.batch.wizard). */
export function batchSendSummary(db, moves) {
  let email = 0;
  let download = 0;
  for (const m of moves) {
    const method = moveSendingMethod(db, m) || 'email';
    if (method === 'manual') download++;
    else email++;
  }
  return {
    total: moves.length,
    email,
    download,
    items: [
      { method: 'email', label: 'Email', count: email },
      { method: 'manual', label: 'Download', count: download },
    ].filter((item) => item.count > 0),
  };
}

/** Compute alert banners for batch Send wizard (account.move.send.batch.wizard). */
export function batchSendAlerts(db, moves) {
  const missingNames = [];
  let missingCount = 0;
  const invalidNames = [];
  let invalidCount = 0;
  for (const m of moves) {
    const method = moveSendingMethod(db, m) || 'email';
    if (method === 'manual') continue;
    const partner = m.partner_id ? read(db, 'res.partner', m.partner_id) : null;
    const email = String(partner?.email ?? '').trim();
    const label = partner?.name || m.name || `#${m.id}`;
    if (!email) {
      missingCount++;
      if (!missingNames.includes(label)) missingNames.push(label);
    } else if (!isValidEmailAddress(email)) {
      invalidCount++;
      if (!invalidNames.includes(label)) invalidNames.push(label);
    }
  }
  const alerts = [];
  if (missingCount > 0) {
    alerts.push({
      level: 'warning',
      code: 'missing_email',
      message: `${missingCount} invoice(s) cannot be emailed because the partner has no email address: ${missingNames.join(', ')}.`,
    });
  }
  if (invalidCount > 0) {
    alerts.push({
      level: 'warning',
      code: 'invalid_email',
      message: `${invalidCount} invoice(s) have a partner with an invalid email address: ${invalidNames.join(', ')}.`,
    });
  }
  return alerts;
}

function defaultPartnerLang(db, move) {
  const partner = move?.partner_id ? read(db, 'res.partner', move.partner_id) : null;
  if (partner?.lang && LANGUAGES.some(([code]) => code === partner.lang)) return partner.lang;
  return LANGUAGES.some(([code]) => code === currentUiLang) ? currentUiLang : 'en';
}

/** Build the single-invoice Send wizard spec (account.move.send.wizard). */
export function sendMoveSingleWizard(db, move) {
  const { emailTargets, manualTargets } = partitionSendMoves(db, [move]);
  const allEmailTargetsReady = emailTargets.length > 0 && emailTargets.every((m) => {
    const p = m.partner_id ? read(db, 'res.partner', m.partner_id) : null;
    return isValidEmailAddress(p?.email);
  });
  const anyManual = manualTargets.some((m) => moveSendingMethod(db, m) === 'manual');
  const defaultPartnerIds = move?.partner_id ? [move.partner_id] : [];
  const defaultTpl = defaultInvoiceMailTemplate(db, move);
  const defaultLang = defaultPartnerLang(db, move);
  const rendered = renderInvoiceMailTemplate(db, defaultTpl, move, defaultLang);
  const defaultAttachments = [
    invoicePdfAttachment(move, 'invoices'),
    ...templateAttachments(defaultTpl),
  ];

  return {
    wizardModel: 'account.move.send.wizard',
    title: 'Send',
    confirmLabel: 'Send',
    fields: [
      {
        name: 'alerts',
        type: 'alerts',
        label: 'Alerts',
        readonly: true,
        compute: (vals, currentDb) => singleSendAlerts(currentDb ?? db, move, vals),
      },
      { name: 'email', type: 'boolean', label: 'Email', default: allEmailTargetsReady },
      { name: 'download', type: 'boolean', label: 'Download', default: anyManual },
      {
        name: 'mail_partner_ids',
        type: 'many2many',
        widget: 'many2many_tags',
        relation: 'res.partner',
        label: 'To',
        default: defaultPartnerIds,
        domain: (p) => p.active !== false,
        invisible: (vals) => !vals?.email,
      },
      {
        name: 'template_id',
        type: 'many2one',
        relation: 'mail.template',
        label: 'Mail Template',
        default: defaultTpl?.id ?? null,
        domain: (tpl) => !tpl?.model || tpl.model === 'account.move',
        invisible: (vals) => !vals?.email,
      },
      {
        name: 'lang',
        type: 'selection',
        label: 'Language',
        options: LANGUAGES,
        default: defaultLang,
        invisible: (vals) => !vals?.email,
      },
      {
        name: 'subject',
        type: 'char',
        label: 'Subject',
        default: rendered.subject,
        invisible: (vals) => !vals?.email,
      },
      {
        name: 'body',
        type: 'text',
        label: 'Body',
        default: rendered.body,
        invisible: (vals) => !vals?.email,
      },
      {
        name: 'pdf_report_id',
        type: 'selection',
        label: 'Invoice report',
        options: INVOICE_PDF_REPORTS,
        default: 'invoices',
        invisible: (vals) => !vals?.email && !vals?.download,
      },
      {
        name: 'attachments',
        type: 'attachments',
        label: 'Attachments',
        default: defaultAttachments,
        invisible: (vals) => !vals?.email,
      },
    ],
    onchange: (vals, key, currentDb) => {
      const activeDb = currentDb ?? db;
      if (key === 'pdf_report_id') {
        const nextReport = vals.pdf_report_id || 'invoices';
        const currentAtts = Array.isArray(vals.attachments) ? vals.attachments : [];
        if (currentAtts.some((att) => att?.kind === 'invoice_pdf')) {
          return {
            attachments: currentAtts.map((att) => (att?.kind === 'invoice_pdf' ? { ...att, pdf_report_id: nextReport } : att)),
          };
        }
        return {};
      }
      if (key === 'template_id' || key === 'lang') {
        const tpl = vals.template_id ? read(activeDb, 'mail.template', vals.template_id) : null;
        const nextLang = vals.lang || defaultLang;
        const nextRendered = tpl
          ? renderInvoiceMailTemplate(activeDb, tpl, move, nextLang)
          : { subject: vals.subject ?? '', body: vals.body ?? '' };
        if (key === 'template_id') {
          const currentAtts = Array.isArray(vals.attachments) ? vals.attachments : [];
          const keptNonTemplate = currentAtts.filter((att) => att?.kind !== 'template');
          return {
            ...nextRendered,
            attachments: [...keptNonTemplate, ...templateAttachments(tpl)],
          };
        }
        return nextRendered;
      }
      return {};
    },
  };
}

/** Build the batch Send wizard spec (account.move.send.batch.wizard). */
export function sendMovesBatchWizard(db, moves) {
  const { emailTargets, manualTargets } = partitionSendMoves(db, moves);
  const allEmailTargetsReady = emailTargets.length > 0 && emailTargets.every((m) => {
    const p = m.partner_id ? read(db, 'res.partner', m.partner_id) : null;
    return isValidEmailAddress(p?.email);
  });
  const anyManual = manualTargets.some((m) => moveSendingMethod(db, m) === 'manual');
  return {
    wizardModel: 'account.move.send.batch.wizard',
    title: 'Send',
    confirmLabel: 'Send',
    fields: [
      {
        name: 'alerts',
        type: 'alerts',
        label: 'Alerts',
        readonly: true,
        compute: (_vals, currentDb) => batchSendAlerts(currentDb ?? db, moves),
      },
      {
        name: 'summary',
        type: 'send_summary',
        label: 'Sending Summary',
        readonly: true,
        compute: (_vals, currentDb) => batchSendSummary(currentDb ?? db, moves),
      },
      { name: 'email', type: 'boolean', label: 'Email', default: allEmailTargetsReady },
      { name: 'download', type: 'boolean', label: 'Download', default: anyManual },
    ],
  };
}

/** Build the single or batch Send wizard depending on selection size. */
export function sendMovesWizard(db, moveOrIds) {
  const moves = resolveSendMoves(db, moveOrIds);
  if (moves.length === 1) return sendMoveSingleWizard(db, moves[0]);
  return sendMovesBatchWizard(db, moves);
}

/** Execute the Send wizard for one or several posted sales invoices/credit notes. */
export function runSendMoves(db, moveOrIds, values = {}) {
  const moves = resolveSendMoves(db, moveOrIds);
  if (!values?.email && !values?.download) {
    throw new Error('Select at least one channel: Email or Download');
  }
  const { emailTargets, manualTargets } = partitionSendMoves(db, moves);
  const emailMoves = values.email ? emailTargets : [];
  const downloadMovesList = values.download ? manualTargets : [];
  const emailPayloads = {};

  if (moves.length === 1 && emailMoves.length === 1) {
    const move = emailMoves[0];
    const partnerIds = Array.isArray(values.mail_partner_ids)
      ? values.mail_partner_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      : (move.partner_id ? [move.partner_id] : []);
    if (!partnerIds.length) throw new Error('Select at least one recipient');
    for (const pid of partnerIds) {
      const p = read(db, 'res.partner', pid);
      const email = String(p?.email ?? '').trim();
      if (!p || !email) throw new Error('The customer has no email address');
      if (!isValidEmailAddress(email)) throw new Error('Enter a valid email address');
    }
    const tplId = 'template_id' in values ? values.template_id : (defaultInvoiceMailTemplate(db, move)?.id ?? null);
    const tpl = tplId ? read(db, 'mail.template', tplId) : null;
    const langCode = values.lang || defaultPartnerLang(db, move);
    const rendered = tpl ? renderInvoiceMailTemplate(db, tpl, move, langCode) : { subject: '', body: '' };
    const pdfReportId = values.pdf_report_id || 'invoices';
    const subject = values.subject !== undefined ? String(values.subject ?? '') : rendered.subject;
    const body = values.body !== undefined ? String(values.body ?? '') : rendered.body;
    const attachments = Array.isArray(values.attachments)
      ? values.attachments.map((att) => (att?.kind === 'invoice_pdf' ? { ...att, pdf_report_id: pdfReportId } : att))
      : [invoicePdfAttachment(move, pdfReportId), ...templateAttachments(tpl)];
    emailPayloads[move.id] = {
      mail_partner_ids: partnerIds,
      template_id: tpl?.id ?? null,
      lang: langCode,
      subject,
      body,
      pdf_report_id: pdfReportId,
      attachments,
    };
  } else {
    for (const move of emailMoves) {
      const tpl = defaultInvoiceMailTemplate(db, move);
      const langCode = defaultPartnerLang(db, move);
      const rendered = tpl ? renderInvoiceMailTemplate(db, tpl, move, langCode) : { subject: '', body: '' };
      emailPayloads[move.id] = {
        mail_partner_ids: move.partner_id ? [move.partner_id] : [],
        template_id: tpl?.id ?? null,
        lang: langCode,
        subject: rendered.subject,
        body: rendered.body,
        pdf_report_id: 'invoices',
        attachments: [invoicePdfAttachment(move, 'invoices'), ...templateAttachments(tpl)],
      };
    }
  }

  const emailSet = new Set(emailMoves.map((m) => m.id));
  const toMarkSent = values.live ? downloadMovesList.filter((m) => !emailSet.has(m.id)) : downloadMovesList;
  const reportQuery = moves.length === 1 && values.pdf_report_id && values.pdf_report_id !== 'invoices'
    ? `?report=${encodeURIComponent(values.pdf_report_id)}`
    : '';
  return {
    db: toMarkSent.reduce((acc, m) => write(acc, 'account.move', m.id, { is_move_sent: true }), db),
    emailIds: emailMoves.map((m) => m.id),
    emailPayloads,
    ...(downloadMovesList.length ? { go: `#/print/account.move/${downloadMovesList.map((m) => m.id).join(',')}${reportQuery}` } : {}),
  };
}
