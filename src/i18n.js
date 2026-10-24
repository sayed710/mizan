// Minimal i18n: English source strings are the keys. Missing keys fall back to English.
const KEY = 'mizan-lang';

const read = () => {
  try { return localStorage.getItem(KEY) || 'en'; } catch { return 'en'; }
};

export const lang = typeof localStorage === 'undefined' ? 'en' : read();
export const isRtl = lang === 'ar';

export function setLang(next) {
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked: stays in current language */ }
  location.reload();
}

const ar = {
  // shell
  'Search for a menu...': 'ابحث عن قائمة...', 'Reset demo': 'إعادة البيانات التجريبية', 'Home menu': 'القائمة الرئيسية',
  'Reset all data to the demo database?': 'هل تريد إعادة كل البيانات إلى البيانات التجريبية؟',
  'No app matches': 'لا يوجد تطبيق يطابق', Applications: 'التطبيقات',
  // apps
  CRM: 'إدارة العملاء', Sales: 'المبيعات', Invoicing: 'الفواتير', Purchase: 'المشتريات', Inventory: 'المخزون',
  Contacts: 'جهات الاتصال', Calendar: 'التقويم', Project: 'المشاريع', Helpdesk: 'الدعم الفني', Employees: 'الموظفون', Settings: 'الإعدادات',
  // menus
  'My Pipeline': 'فرصي', Quotations: 'عروض الأسعار', Customers: 'العملاء', Reporting: 'التقارير', 'Pipeline Analysis': 'تحليل الفرص',
  Forecast: 'التوقعات', Orders: 'الطلبات', 'To Invoice': 'للفوترة', Products: 'المنتجات', Dashboard: 'لوحة التحكم', Invoices: 'الفواتير',
  Vendors: 'الموردون', Bills: 'فواتير الموردين', 'Invoice Analysis': 'تحليل الفواتير', 'Requests for Quotation': 'طلبات عروض الأسعار',
  'Purchase Orders': 'أوامر الشراء', Stock: 'المخزون', Meetings: 'الاجتماعات', Projects: 'المشاريع', 'All Tasks': 'كل المهام',
  Tickets: 'التذاكر', Departments: 'الأقسام', 'General Settings': 'الإعدادات العامة', Pipeline: 'الفرص', Tasks: 'المهام',
  // control panel / search
  New: 'جديد', 'Search...': 'بحث...', Search: 'بحث', Filters: 'عوامل التصفية', 'Group By': 'تجميع حسب', Favorites: 'المفضلة',
  'Save current search': 'حفظ البحث الحالي', 'Saved search name': 'اسم البحث المحفوظ', 'Remove filter': 'إزالة الفلتر', or: 'أو',
  'Toggle search panel': 'إظهار لوحة البحث', 'Switch view': 'تبديل العرض', kanban: 'كانبان', list: 'قائمة', graph: 'رسم بياني',
  pivot: 'جدول محوري', calendar: 'تقويم', 'Delete': 'حذف', 'Delete {n} record(s)?': 'حذف {n} سجل؟', Export: 'تصدير',
  'No record found. Create one with “New”.': 'لا توجد سجلات. أنشئ سجلاً جديداً بزر «جديد».', Total: 'الإجمالي', None: 'لا شيء',
  Yes: 'نعم', No: 'لا', Count: 'العدد', Measure: 'المقياس', Rows: 'الصفوف', Columns: 'الأعمدة', Bar: 'أعمدة', Line: 'خطي', Pie: 'دائري',
  Today: 'اليوم', Month: 'شهر', 'Add': 'إضافة', Discard: 'تجاهل', Save: 'حفظ', 'e.g. Product pricing': 'مثال: تسعير منتج',
  'Show data table': 'عرض جدول البيانات', 'Hide data table': 'إخفاء جدول البيانات',
  // form
  'Record not found.': 'السجل غير موجود.', 'Back to': 'العودة إلى', 'Previous record': 'السجل السابق', 'Next record': 'السجل التالي',
  'Log an internal note…': 'سجّل ملاحظة داخلية…', 'Log note': 'تسجيل ملاحظة', 'No messages yet.': 'لا توجد رسائل بعد.',
  'Add a description…': 'أضف وصفاً…', 'Add a tag…': 'أضف وسماً…', 'Add a line': 'إضافة بند', 'Select a product…': 'اختر منتجاً…',
  Subtotal: 'المجموع الفرعي', Archived: 'مؤرشف', 'Could not save': 'تعذّر الحفظ', 'is required': 'مطلوب',
  // buttons
  Won: 'مكسوبة', Lost: 'خاسرة', Restore: 'استعادة', 'Send by Email': 'إرسال بالبريد', Confirm: 'تأكيد', 'Create Invoice': 'إنشاء فاتورة',
  Cancel: 'إلغاء', 'Send RFQ': 'إرسال الطلب', 'Confirm Order': 'تأكيد الطلب', 'Receive Products': 'استلام المنتجات', 'Create Bill': 'إنشاء فاتورة مورد',
  'Register Payment': 'تسجيل دفعة', Print: 'طباعة', 'Reset to Draft': 'إعادة إلى مسودة', 'Update Quantity': 'تحديث الكمية',
  Paid: 'مدفوعة', Partial: 'مدفوعة جزئياً', Cancelled: 'ملغاة', Received: 'تم الاستلام',
  // stages / options
  Qualified: 'مؤهلة', Proposition: 'عرض', Quotation: 'عرض سعر', 'Quotation Sent': 'تم إرسال العرض', 'Sales Order': 'أمر بيع',
  RFQ: 'طلب عرض', 'RFQ Sent': 'تم إرسال الطلب', 'Purchase Order': 'أمر شراء', Draft: 'مسودة', Posted: 'مُرحّلة',
  'Not Paid': 'غير مدفوعة', 'Partially Paid': 'مدفوعة جزئياً', 'Customer Invoice': 'فاتورة عميل', 'Vendor Bill': 'فاتورة مورد',
  Goods: 'سلع', Service: 'خدمة', Office: 'المكتب', Home: 'المنزل', Other: 'أخرى', 'To Do': 'للتنفيذ', 'In Progress': 'قيد التنفيذ',
  Review: 'مراجعة', Done: 'منجزة', 'On Hold': 'معلّقة', Solved: 'تم الحل', Question: 'استفسار', Issue: 'مشكلة', Request: 'طلب',
  // filters
  Companies: 'الشركات', Individuals: 'الأفراد', Unassigned: 'غير مسندة', Ongoing: 'جارية', Overdue: 'متأخرة', 'Sales Orders': 'أوامر البيع',
  'This Month': 'هذا الشهر', 'This Year': 'هذا العام', Services: 'الخدمات', 'Below Minimum': 'أقل من الحد الأدنى', RFQs: 'طلبات العروض',
  'To Receive': 'للاستلام', Remote: 'عن بُعد', 'Open Tasks': 'مهام مفتوحة', Late: 'متأخرة', 'My Tickets': 'تذاكري', Open: 'مفتوحة', Urgent: 'عاجلة',
  // fields
  Name: 'الاسم', Company: 'شركة', Email: 'البريد الإلكتروني', Phone: 'الهاتف', City: 'المدينة', Country: 'الدولة', 'Tax ID': 'الرقم الضريبي',
  Tags: 'الوسوم', Opportunity: 'الفرصة', Contact: 'جهة الاتصال', 'Expected Revenue': 'الإيراد المتوقع', 'Probability (%)': 'الاحتمالية (%)',
  Stage: 'المرحلة', Salesperson: 'مندوب المبيعات', 'Expected Closing': 'الإغلاق المتوقع', 'Created on': 'تاريخ الإنشاء', Priority: 'الأولوية',
  Notes: 'ملاحظات', 'Product Name': 'اسم المنتج', 'Internal Reference': 'المرجع الداخلي', 'Product Type': 'نوع المنتج', Category: 'الفئة',
  'Sales Price': 'سعر البيع', Cost: 'التكلفة', 'On Hand': 'الكمية المتاحة', 'Min. Quantity': 'الحد الأدنى', Number: 'الرقم', Customer: 'العميل',
  'Order Date': 'تاريخ الطلب', Expiration: 'تاريخ الانتهاء', Status: 'الحالة', 'Order Lines': 'بنود الطلب', Product: 'المنتج', Quantity: 'الكمية',
  'Unit Price': 'سعر الوحدة', 'Tax %': 'الضريبة %', 'Untaxed Amount': 'المبلغ قبل الضريبة', Taxes: 'الضرائب', Reference: 'المرجع',
  Vendor: 'المورد', 'Order Deadline': 'آخر موعد للطلب', 'Expected Arrival': 'الوصول المتوقع', Type: 'النوع', Partner: 'الشريك',
  'Invoice Date': 'تاريخ الفاتورة', 'Due Date': 'تاريخ الاستحقاق', 'Source Document': 'المستند المصدر', 'Payment Reference': 'مرجع الدفع',
  'Invoice Lines': 'بنود الفاتورة', 'Tax Excluded': 'بدون ضريبة', 'Amount Due': 'المبلغ المستحق', 'Payment Status': 'حالة الدفع',
  'Paid on': 'تاريخ الدفع', 'Terms and Conditions': 'الشروط والأحكام', 'Other Info': 'معلومات أخرى', 'Department Name': 'اسم القسم',
  Manager: 'المدير', 'Employee Name': 'اسم الموظف', 'Job Title': 'المسمى الوظيفي', Department: 'القسم', 'Work Email': 'البريد الوظيفي',
  'Work Phone': 'هاتف العمل', 'Work Location': 'مكان العمل', 'Joined on': 'تاريخ الانضمام', 'Project Name': 'اسم المشروع',
  'Project Manager': 'مدير المشروع', 'Start Date': 'تاريخ البدء', 'End Date': 'تاريخ الانتهاء', Description: 'الوصف', 'Task Title': 'عنوان المهمة',
  Assignee: 'المكلّف', Deadline: 'الموعد النهائي', 'Allocated Hours': 'الساعات المخصصة', Subject: 'الموضوع', 'Assigned to': 'مسندة إلى',
  'Meeting Subject': 'موضوع الاجتماع', Date: 'التاريخ', Time: 'الوقت', 'Duration (hours)': 'المدة (ساعات)', Attendee: 'الحضور', Location: 'المكان',
  Opportunities: 'الفرص', Invoiced: 'المفوتر', 'Sales Order ': 'أمر البيع',
  Login: 'اسم الدخول', Password: 'كلمة المرور', 'Log in': 'تسجيل الدخول', 'Log out': 'تسجيل الخروج', Users: 'المستخدمون',
  'Add user': 'إضافة مستخدم', Administrator: 'مدير', 'Wrong login or password': 'اسم الدخول أو كلمة المرور غير صحيحة',
  'Browser-only demo mode: data is stored in this browser.': 'وضع تجريبي: البيانات محفوظة في هذا المتصفح فقط.',
  Manufacturing: 'التصنيع', 'Point of Sale': 'نقاط البيع', Expenses: 'المصروفات', 'Time Off': 'الإجازات', Recruitment: 'التوظيف',
  Timesheets: 'سجلات الوقت', Events: 'الفعاليات', Subscriptions: 'الاشتراكات', 'To-do': 'المهام اليومية', Knowledge: 'المعرفة',
  'Manufacturing Orders': 'أوامر التصنيع', 'Bills of Materials': 'قوائم المواد', Register: 'الكاشير', 'My Expenses': 'مصروفاتي',
  'To Approve': 'بانتظار الموافقة', 'My Time Off': 'إجازاتي', 'Job Positions': 'الوظائف', Applications: 'طلبات التوظيف',
  'My Timesheets': 'سجلات وقتي', Attendees: 'الحضور', Articles: 'المقالات', Produce: 'إنتاج', Submit: 'إرسال', Approve: 'موافقة',
  Refuse: 'رفض', 'Mark as Paid': 'تحديد كمدفوع', Start: 'بدء', 'Generate Invoice': 'إنشاء فاتورة', Pause: 'إيقاف مؤقت', Resume: 'استئناف',
  Close: 'إغلاق', Attended: 'حضر', Cash: 'نقدي', Card: 'بطاقة', 'New Order': 'طلب جديد', 'Search products...': 'ابحث عن منتج...',
  All: 'الكل', Order: 'الطلب', 'Add products to start an order.': 'أضف منتجات لبدء الطلب.', 'Hours Spent': 'الساعات المستغرقة',
  Confirmed: 'مؤكد', 'To Submit': 'للإرسال', Submitted: 'مُرسل', Approved: 'موافق عليه', Refused: 'مرفوض', Inbox: 'الوارد',
  'This Week': 'هذا الأسبوع', Later: 'لاحقاً', Monthly: 'شهري', Yearly: 'سنوي', 'In Progress ': 'قيد التنفيذ', Paused: 'متوقف', Closed: 'مغلق',
  Registered: 'مسجّل', Announced: 'مُعلن', Booked: 'محجوز', Ended: 'انتهى', Interview: 'مقابلة', 'Initial Qualification': 'تقييم أولي',
  'Contract Proposal': 'عرض عقد', 'Contract Signed': 'تم توقيع العقد', Travel: 'سفر', Meals: 'وجبات', 'Office Supplies': 'أدوات مكتبية',
  'Paid Time Off': 'إجازة مدفوعة', 'Sick Time Off': 'إجازة مرضية', Unpaid: 'غير مدفوعة', 'Compensatory Days': 'أيام تعويضية',
  Workspace: 'مساحة العمل', Shared: 'مشتركة', Private: 'خاصة', 'Monthly Recurring Revenue': 'الإيراد الشهري المتكرر',
  Discuss: 'المحادثات', Channels: 'القنوات', Activities: 'الأنشطة', 'Channel Name': 'اسم القناة', Message: 'رسالة', Send: 'إرسال',
  'Schedule Activity': 'جدولة نشاط', Schedule: 'جدولة', 'Mark Done': 'تم الإنجاز', 'Open Document': 'فتح المستند', Summary: 'الملخص',
  'Activity Type': 'نوع النشاط', 'To-Do': 'مهمة', Call: 'مكالمة', Meeting: 'اجتماع', 'Upload Document': 'رفع مستند', Planned: 'مخطط',
  Actions: 'إجراءات', Duplicate: 'تكرار', Archive: 'أرشفة', Unarchive: 'إلغاء الأرشفة', Import: 'استيراد',
  '{n} record(s) imported.': 'تم استيراد {n} سجل.', 'Import failed': 'فشل الاستيراد', Document: 'المستند',
  Payroll: 'الرواتب', 'Payslip Batches': 'دفعات الرواتب', Payslips: 'قسائم الرواتب', 'Compute Sheet': 'احتساب القسيمة',
  'Generate Payslips': 'إنشاء القسائم', 'Confirm All': 'تأكيد الكل', 'Pay All': 'صرف الكل', 'Salary Computation': 'احتساب الراتب',
  'Basic Wage': 'الراتب الأساسي', 'Gross Wage': 'إجمالي الراتب', 'Net Wage': 'صافي الراتب', 'Monthly Wage': 'الراتب الشهري',
  Employee: 'الموظف', Batch: 'الدفعة', From: 'من', To: 'إلى', Code: 'الكود', Amount: 'المبلغ',
  'Journal Entries': 'القيود اليومية', 'Miscellaneous Entries': 'قيود متنوعة', 'Profit and Loss': 'الأرباح والخسائر',
  'Balance Sheet': 'الميزانية العمومية', 'General Ledger': 'دفتر الأستاذ العام', 'Chart of Accounts': 'دليل الحسابات', Journals: 'اليوميات',
  'Journal Items': 'بنود القيد', 'Journal Entry': 'قيد يومية', Account: 'الحساب', Label: 'البيان', Debit: 'مدين', Credit: 'دائن',
  Balance: 'الرصيد', Revenue: 'الإيرادات', 'Cost of Revenue': 'تكلفة الإيرادات', 'Gross Profit': 'مجمل الربح', 'Net Operating Income': 'صافي الدخل التشغيلي',
  'Other Expenses': 'مصروفات أخرى', 'Net Income': 'صافي الدخل', Assets: 'الأصول', 'Total Assets': 'إجمالي الأصول', Liabilities: 'الخصوم',
  Equity: 'حقوق الملكية', 'Current Year Earnings': 'أرباح العام الحالي', 'Liabilities + Equity': 'الخصوم + حقوق الملكية',
  'Initial Balance': 'الرصيد الافتتاحي', Period: 'الفترة', 'This Quarter': 'هذا الربع', 'All Dates': 'كل التواريخ', Journal: 'اليومية',
  'Account Name': 'اسم الحساب', 'Journal Name': 'اسم اليومية', 'Short Code': 'الكود المختصر', 'Default Account': 'الحساب الافتراضي',
  Receivable: 'المدينون', 'Bank and Cash': 'البنك والنقدية', 'Current Assets': 'الأصول المتداولة', 'Fixed Assets': 'الأصول الثابتة',
  'Current Liabilities': 'الخصوم المتداولة', Income: 'الإيرادات', Entries: 'القيود',
  // dashboard & settings
  Receivable: 'المستحق من العملاء', Payable: 'المستحق للموردين', 'Invoiced this month': 'المفوتر هذا الشهر', 'Overdue invoices': 'فواتير متأخرة',
  'Monthly invoiced': 'الفوترة الشهرية', 'Top customers': 'أكبر العملاء', 'Company Name': 'اسم الشركة', Language: 'اللغة', Data: 'البيانات',
  'Download backup': 'تنزيل نسخة احتياطية', 'Restore backup': 'استعادة نسخة احتياطية', 'Backup restored.': 'تمت استعادة النسخة الاحتياطية.',
  'Invalid backup file.': 'ملف النسخة الاحتياطية غير صالح.', 'Records stored': 'السجلات المخزنة', 'Payment amount': 'مبلغ الدفعة',
  'New on-hand quantity': 'الكمية الجديدة المتاحة', 'record created': 'تم إنشاء السجل', 'Payment of {amount} registered': 'تم تسجيل دفعة بقيمة {amount}',
};

/** Translate an English UI string; `{name}` placeholders are filled from `vars`. */
export function t(s, vars) {
  if (s == null) return '';
  const out = (lang === 'ar' && ar[s]) || s;
  return vars ? out.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : out;
}
