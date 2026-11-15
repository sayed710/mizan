// App launcher icons: flat cut-paper shapes in one shared palette (colours live in styles.css as --i-* tokens).
// Classes: f-<tone> fills, s-<tone> strokes (round caps, no fill). Tones: t teal, b blue, p plum, c coral,
// a amber, g green, s sky, r rose, n ink, k slate, w paper.

const GLYPHS = {
  discuss: <>
    <rect className="f-c" x="6" y="9" width="27" height="20" rx="7" />
    <path className="f-c" d="M12 27v10l10-10z" />
    <rect className="f-a" x="20" y="21" width="22" height="16" rx="6" />
    <path className="f-a" d="M36 35v7l-8-7z" />
  </>,
  crm: <>
    <rect className="f-t" x="6" y="9" width="36" height="8" rx="4" />
    <rect className="f-s" x="11" y="20" width="26" height="8" rx="4" />
    <rect className="f-b" x="16" y="31" width="16" height="8" rx="4" />
    <circle className="f-c" cx="37" cy="35" r="4.5" />
  </>,
  sales: <>
    <rect className="f-a" x="7" y="27" width="9" height="14" rx="3" />
    <rect className="f-c" x="19.5" y="19" width="9" height="22" rx="3" />
    <rect className="f-p" x="32" y="10" width="9" height="31" rx="3" />
    <path className="s-n" strokeWidth="3" d="M8 19l9-7 6 3 9-8" />
  </>,
  accounting: <>
    <rect className="f-n" x="22.4" y="9" width="3.2" height="27" rx="1.6" />
    <rect className="f-n" x="7" y="12.5" width="34" height="3.2" rx="1.6" />
    <rect className="f-n" x="15" y="35.5" width="18" height="4.5" rx="2.25" />
    <path className="f-p" d="M5 22h16a8 8 0 01-16 0z" />
    <path className="f-t" d="M27 22h16a8 8 0 01-16 0z" />
    <circle className="f-a" cx="24" cy="9" r="3.6" />
  </>,
  purchase: <>
    <path className="s-n" strokeWidth="3.2" d="M17 18v-3a7 7 0 0114 0v3" />
    <rect className="f-s" x="9" y="17" width="30" height="24" rx="6" />
    <rect className="f-b" x="9" y="31" width="30" height="10" rx="5" />
    <circle className="f-a" cx="34" cy="24" r="3" />
  </>,
  inventory: <>
    <rect className="f-t" x="16" y="6" width="16" height="16" rx="4" />
    <rect className="f-a" x="6" y="25" width="16" height="16" rx="4" />
    <rect className="f-c" x="26" y="25" width="16" height="16" rx="4" />
    <rect className="f-w" x="22.5" y="6" width="3" height="7" />
    <rect className="f-w" x="12.5" y="25" width="3" height="7" />
    <rect className="f-w" x="32.5" y="25" width="3" height="7" />
  </>,
  contacts: <>
    <rect className="f-t" x="5" y="9" width="38" height="30" rx="7" />
    <circle className="f-w" cx="17" cy="20.5" r="5" />
    <path className="f-w" d="M8.5 34a8.5 8.5 0 0117 0z" />
    <rect className="f-n" x="29" y="17" width="10" height="3.2" rx="1.6" />
    <rect className="f-n" x="29" y="24" width="7" height="3.2" rx="1.6" />
  </>,
  calendar: <>
    <rect className="f-s" x="6" y="10" width="36" height="31" rx="7" />
    <path className="f-c" d="M13 10h22a7 7 0 017 7v3H6v-3a7 7 0 017-7z" />
    <rect className="f-n" x="14" y="5.5" width="3.4" height="9" rx="1.7" />
    <rect className="f-n" x="30.6" y="5.5" width="3.4" height="9" rx="1.7" />
    <rect className="f-w" x="13" y="26" width="7" height="7" rx="2" />
    <rect className="f-n" x="24" y="26" width="7" height="7" rx="2" />
  </>,
  project: <>
    <rect className="f-t" x="6" y="8" width="10" height="32" rx="4" />
    <rect className="f-a" x="19" y="8" width="10" height="19" rx="4" />
    <rect className="f-c" x="32" y="8" width="10" height="26" rx="4" />
  </>,
  helpdesk: <>
    <circle className="s-r" strokeWidth="9" cx="24" cy="24" r="13.5" />
    <circle className="s-w butt" strokeWidth="10" strokeDasharray="10.6 10.6" strokeDashoffset="5.3" cx="24" cy="24" r="13.5" />
  </>,
  employees: <>
    <circle className="f-s" cx="11" cy="18" r="5" />
    <path className="f-s" d="M3 37a8 8 0 0116 0z" />
    <circle className="f-a" cx="37" cy="18" r="5" />
    <path className="f-a" d="M29 37a8 8 0 0116 0z" />
    <circle className="f-t" cx="24" cy="15" r="6.5" />
    <path className="f-t" d="M13 40a11 11 0 0122 0z" />
  </>,
  manufacturing: <>
    <path className="f-n" d="M5 40V23l11 6v-6l11 6V11h9a3 3 0 013 3v26z" />
    <rect className="f-a" x="11" y="32" width="5" height="5" rx="1.2" />
    <rect className="f-a" x="20" y="32" width="5" height="5" rx="1.2" />
    <rect className="f-a" x="29" y="32" width="5" height="5" rx="1.2" />
    <circle className="f-k" cx="41" cy="8" r="3.5" />
  </>,
  kitchen: <>
    <rect className="f-n" x="5" y="8" width="38" height="26" rx="6" />
    <rect className="f-a" x="10" y="13" width="8" height="15" rx="2" />
    <rect className="f-c" x="20" y="13" width="8" height="10" rx="2" />
    <rect className="f-t" x="30" y="13" width="8" height="13" rx="2" />
    <rect className="f-k" x="16" y="37" width="16" height="3.6" rx="1.8" />
  </>,
  pos: <>
    <rect className="f-t" x="13" y="6" width="22" height="14" rx="4" />
    <rect className="f-n" x="6" y="19" width="36" height="22" rx="6" />
    <circle className="f-a" cx="15" cy="27" r="2.4" />
    <circle className="f-w" cx="24" cy="27" r="2.4" />
    <circle className="f-w" cx="33" cy="27" r="2.4" />
    <rect className="f-c" x="12" y="33" width="24" height="3.6" rx="1.8" />
  </>,
  expenses: <>
    <path className="f-s" d="M9 9a3 3 0 013-3h20a3 3 0 013 3v32l-4.3-3-4.4 3-4.3-3-4.3 3-4.4-3L9 41z" />
    <rect className="f-n" x="14" y="13" width="14" height="3.2" rx="1.6" />
    <rect className="f-n" x="14" y="20" width="9" height="3.2" rx="1.6" />
    <circle className="f-a" cx="34" cy="31" r="9" />
    <circle className="s-n" strokeWidth="2.4" cx="34" cy="31" r="4" />
  </>,
  timeoff: <>
    <circle className="f-a" cx="37" cy="11" r="5.5" />
    <path className="f-c" d="M5 25a17 17 0 0134 0z" />
    <path className="f-w" d="M16 25a6 17 0 0112 0z" />
    <rect className="f-n" x="20.6" y="25" width="2.8" height="15" rx="1.4" />
    <rect className="f-g" x="9" y="38" width="30" height="4" rx="2" />
  </>,
  recruitment: <>
    <circle className="f-p" cx="18" cy="15" r="6.5" />
    <path className="f-p" d="M6 40a12 12 0 0124 0z" />
    <circle className="f-w" cx="32" cy="28" r="6" />
    <circle className="s-t" strokeWidth="3.6" cx="32" cy="28" r="7.5" />
    <path className="s-t" strokeWidth="4" d="M37.6 33.6l5 5" />
  </>,
  timesheets: <>
    <rect className="f-n" x="20.5" y="4" width="7" height="6" rx="2" />
    <circle className="f-b" cx="24" cy="26" r="15.5" />
    <path className="f-a" d="M24 26V13.5A12.5 12.5 0 0136.5 26z" />
    <circle className="f-w" cx="24" cy="26" r="2.6" />
  </>,
  events: <>
    <path className="s-n" strokeWidth="2.6" d="M4 10q20 9 40 0" />
    <path className="f-c" d="M8 13.5l9 2.8-5.6 12.5z" />
    <path className="f-a" d="M19.5 16.8h9L24 32z" />
    <path className="f-t" d="M31 16.3l9-2.8-3.4 15.3z" />
    <circle className="f-p" cx="12" cy="38" r="3" />
    <circle className="f-s" cx="35" cy="37" r="2.4" />
  </>,
  subscriptions: <>
    <path className="s-t" strokeWidth="6" d="M10.5 21A14 14 0 0134 14" />
    <path className="f-t" d="M39.5 8.5v12h-12z" />
    <path className="s-a" strokeWidth="6" d="M37.5 27A14 14 0 0114 34" />
    <path className="f-a" d="M8.5 39.5v-12h12z" />
  </>,
  payroll: <>
    <rect className="f-g" x="4" y="12" width="34" height="21" rx="5" />
    <circle className="f-w" cx="21" cy="22.5" r="5.5" />
    <circle className="f-a" cx="34" cy="32" r="9.5" />
    <rect className="f-n" x="32.5" y="26.5" width="3" height="11" rx="1.5" />
  </>,
  marketing: <>
    <rect className="f-b" x="5" y="11" width="38" height="27" rx="7" />
    <path className="f-s" d="M8.5 13h31L24 28z" />
    <circle className="f-c" cx="39" cy="12" r="5.5" />
  </>,
  sign: <>
    <path className="s-t" strokeWidth="3.6" d="M6 35c5-11 8 3 12-4s6 4 9 1 5-3 9-3" />
    <path className="f-p" d="M28 21L39.5 9.5a3.5 3.5 0 015 5L33 26z" />
    <path className="f-n" d="M28 21l5 5-7.5 2.5z" />
    <rect className="f-k" x="6" y="39.5" width="36" height="2.6" rx="1.3" />
  </>,
  documents: <>
    <path className="f-n" d="M5 14a5 5 0 015-5h8.5l4.5 5.5H38a5 5 0 015 5V22H5z" />
    <rect className="f-a" x="5" y="18" width="38" height="22" rx="6" />
    <rect className="f-w" x="11" y="31" width="12" height="3.2" rx="1.6" />
  </>,
  planning: <>
    <rect className="f-t" x="5" y="9" width="22" height="8" rx="4" />
    <rect className="f-p" x="14" y="20" width="29" height="8" rx="4" />
    <rect className="f-a" x="9" y="31" width="18" height="8" rx="4" />
  </>,
  rental: <>
    <circle className="s-c" strokeWidth="6.5" cx="15" cy="24" r="7.5" />
    <rect className="f-c" x="22" y="21" width="22" height="6" rx="3" />
    <rect className="f-n" x="32" y="26" width="4.5" height="7" rx="2" />
    <rect className="f-n" x="39" y="26" width="4.5" height="5" rx="2" />
  </>,
  appointments: <>
    <rect className="f-b" x="5" y="9" width="32" height="29" rx="7" />
    <rect className="f-n" x="12" y="5" width="3.4" height="8.5" rx="1.7" />
    <rect className="f-n" x="27" y="5" width="3.4" height="8.5" rx="1.7" />
    <circle className="f-a" cx="33" cy="32" r="10.5" />
    <path className="s-n" strokeWidth="3" d="M33 26.5V32l4 2.5" />
  </>,
  website: <>
    <rect className="f-s" x="5" y="8" width="38" height="32" rx="7" />
    <path className="f-n" d="M12 8h24a7 7 0 017 7v2H5v-2a7 7 0 017-7z" />
    <circle className="f-c" cx="11" cy="12.5" r="1.8" />
    <circle className="f-a" cx="16.5" cy="12.5" r="1.8" />
    <rect className="f-t" x="10" y="22" width="12" height="13" rx="3" />
    <rect className="f-w" x="26" y="23" width="12" height="3.2" rx="1.6" />
    <rect className="f-w" x="26" y="30" width="8" height="3.2" rx="1.6" />
  </>,
  barcode: <>
    <rect className="f-n" x="6" y="10" width="4.5" height="28" rx="1.5" />
    <rect className="f-n" x="13" y="10" width="2.5" height="28" rx="1.2" />
    <rect className="f-n" x="18" y="10" width="6" height="28" rx="1.5" />
    <rect className="f-n" x="27" y="10" width="2.5" height="28" rx="1.2" />
    <rect className="f-n" x="32" y="10" width="4" height="28" rx="1.5" />
    <rect className="f-n" x="38.5" y="10" width="3.5" height="28" rx="1.5" />
    <rect className="f-c" x="3" y="22.2" width="42" height="3.6" rx="1.8" />
  </>,
  shopfloor: <>
    <path className="f-a" d="M9 30a15 15 0 0130 0z" />
    <rect className="f-n" x="21.5" y="11" width="5" height="14" rx="2.5" />
    <rect className="f-c" x="5" y="29" width="38" height="6.5" rx="3.25" />
  </>,
  dashboards: <>
    <rect className="f-b" x="6" y="6" width="16" height="22" rx="4.5" />
    <rect className="f-c" x="25" y="6" width="17" height="11" rx="4.5" />
    <rect className="f-t" x="25" y="20" width="17" height="22" rx="4.5" />
    <rect className="f-a" x="6" y="31" width="16" height="11" rx="4.5" />
  </>,
  maintenance: <>
    <path className="f-k" d="M30.5 5a11 11 0 00-10.3 14.8L6.6 33.4a4.6 4.6 0 006.5 6.5l13.6-13.6A11 11 0 0041.6 13l-6.3 6.3-5.4-1.4-1.4-5.4L34.8 6a11 11 0 00-4.3-1z" />
    <circle className="f-a" cx="10.2" cy="37" r="2" />
  </>,
  quality: <>
    <path className="f-g" d="M24 5l16 5.5V22c0 9.5-6.4 16-16 20C14.400 38 8 31.500 8 22V10.500z" />
    <path className="s-w" strokeWidth="4.4" d="M16.500 23l5.500 5.500 10-11" />
  </>,
  fleet: <>
    <path className="f-b" d="M4 31v-6.500a3 3 0 012-2.800l4.500-1.700 4.300-7a4 4 0 013.400-2h11.600a4 4 0 013.200 1.600l5.500 7.400 3.500 1.300a3 3 0 012 2.800V31a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
    <path className="f-s" d="M17.500 14.500h5V20h-8.300zM25.500 14.500h5.300l4 5.500h-9.300z" />
    <circle className="f-n" cx="14" cy="33" r="5" />
    <circle className="f-n" cx="34" cy="33" r="5" />
    <circle className="f-w" cx="14" cy="33" r="1.8" />
    <circle className="f-w" cx="34" cy="33" r="1.800" />
  </>,
  attendances: <>
    <rect className="f-t" x="10" y="9" width="28" height="33" rx="7" />
    <rect className="f-n" x="19" y="5" width="10" height="8" rx="3" />
    <circle className="f-w" cx="24" cy="22" r="5" />
    <path className="f-w" d="M15.500 36a8.500 8.500 0 0117 0z" />
  </>,
  appraisals: <>
    <path className="f-c" d="M14 26l-5 15 8-3 4.500 6 4-14z" />
    <path className="f-p" d="M34 26l5 15-8-3-4.500 6-4-14z" />
    <circle className="f-a" cx="24" cy="18" r="13" />
    <path className="f-w" d="M24 10.500l2.300 4.800 5.200.700-3.800 3.600.900 5.200L24 22.300l-4.600 2.500.900-5.200-3.800-3.600 5.200-.700z" />
  </>,
  surveys: <>
    <rect className="f-p" x="8" y="8" width="32" height="35" rx="7" />
    <rect className="f-n" x="17" y="4.500" width="14" height="8" rx="4" />
    <circle className="f-a" cx="16" cy="21" r="2.600" />
    <rect className="f-w" x="21.500" y="19.400" width="13" height="3.200" rx="1.600" />
    <circle className="f-w" cx="16" cy="29" r="2.600" />
    <rect className="f-w" x="21.500" y="27.400" width="13" height="3.200" rx="1.600" />
    <circle className="f-w" cx="16" cy="37" r="2.600" />
    <rect className="f-w" x="21.500" y="35.400" width="8" height="3.200" rx="1.600" />
  </>,
  lunch: <>
    <path className="s-a" strokeWidth="3" d="M17 6c-3 3 3 5 0 9M27 6c-3 3 3 5 0 9" />
    <path className="f-c" d="M5 21h38a19 17 0 01-38 0z" />
    <rect className="f-n" x="15" y="38" width="18" height="4" rx="2" />
    <rect className="f-w" x="5" y="21" width="38" height="3.400" rx="1.700" />
  </>,
  approvals: <>
    <circle className="f-g" cx="24" cy="24" r="18" />
    <circle className="s-w" strokeWidth="2.400" strokeDasharray="1 5.300" cx="24" cy="24" r="14" />
    <path className="s-w" strokeWidth="4.400" d="M16.500 24.500l5.200 5.200L32 19" />
  </>,
  repairs: <>
    <rect className="f-a" x="21.800" y="16" width="5.400" height="27" rx="2.700" transform="rotate(38 24.500 29.500)" />
    <path className="f-k" d="M9.500 15.500l10-9.500a4 4 0 015.600.100l8.400 8.500-6 6-5-5-7 6.500z" />
  </>,
  fieldservice: <>
    <path className="f-c" d="M24 4a14 14 0 0114 14c0 10.500-14 26-14 26S10 28.500 10 18A14 14 0 0124 4z" />
    <circle className="f-w" cx="24" cy="18" r="5.500" />
  </>,
  frontdesk: <>
    <rect className="f-n" x="22.400" y="9" width="3.200" height="6" rx="1.600" />
    <circle className="f-a" cx="24" cy="8.500" r="3" />
    <path className="f-s" d="M8 31a16 16 0 0132 0z" />
    <rect className="f-n" x="5" y="31" width="38" height="6" rx="3" />
    <rect className="f-k" x="12" y="39" width="24" height="3" rx="1.500" />
  </>,
  elearning: <>
    <path className="f-t" d="M12 22v9.500c0 3.500 5.400 6.500 12 6.500s12-3 12-6.500V22l-12 5.500z" />
    <path className="f-n" d="M24 8l21 9.500-21 9.500L3 17.500z" />
    <rect className="f-a" x="40.500" y="18" width="2.800" height="13" rx="1.400" />
    <circle className="f-a" cx="41.900" cy="33" r="2.800" />
  </>,
  livechat: <>
    <path className="f-t" d="M24 6c10.500 0 19 7 19 16s-8.500 16-19 16c-2 0-4-.300-5.800-.700L9 42l1.800-8C7.200 31 5 26.700 5 22c0-9 8.500-16 19-16z" />
    <circle className="f-w" cx="16" cy="22" r="2.700" />
    <circle className="f-w" cx="24" cy="22" r="2.700" />
    <circle className="f-w" cx="32" cy="22" r="2.700" />
  </>,
  sms: <>
    <rect className="f-n" x="8" y="5" width="20" height="38" rx="5.500" />
    <rect className="f-k" x="15" y="37" width="6" height="2.600" rx="1.300" />
    <rect className="f-r" x="19" y="11" width="24" height="16" rx="6" />
    <path className="f-r" d="M24 25v8l8-8z" />
    <rect className="f-w" x="24.500" y="17.400" width="13" height="3.200" rx="1.600" />
  </>,
  whatsapp: <>
    <path className="f-g" d="M24 5a19 19 0 11-9.800 35.300L6 43l2.700-8.200A19 19 0 0124 5z" />
    <path className="f-w" d="M18.500 14.500c-1.500.600-2.600 2.200-2.200 4.300 1.200 6 5.800 10.600 11.800 11.800 2.100.400 3.700-.700 4.300-2.200l-3.800-3.200-2.600 1.500c-2-.900-3.600-2.500-4.500-4.500l1.500-2.600z" />
  </>,
  social: <>
    <path className="s-n" strokeWidth="3" d="M33 12L15 24l18 12" />
    <circle className="f-r" cx="34" cy="11" r="7" />
    <circle className="f-a" cx="13" cy="24" r="7" />
    <circle className="f-b" cx="34" cy="37" r="7" />
  </>,
  automation: <>
    <path className="s-n" strokeWidth="3" d="M24 15v6M24 21H12v7M24 21h12v7" />
    <rect className="f-t" x="16" y="5" width="16" height="11" rx="4" />
    <rect className="f-a" x="5" y="28" width="15" height="13" rx="4.500" />
    <circle className="f-p" cx="36" cy="34.500" r="7.500" />
  </>,
  plm: <>
    <path className="f-b" d="M24 22l19 9-19 9L5 31z" />
    <path className="f-s" d="M24 15l19 9-19 9L5 24z" />
    <path className="f-t" d="M24 8l19 9-19 9L5 17z" />
  </>,
  rooms: <>
    <rect className="f-s" x="18" y="4" width="12" height="7" rx="3.500" />
    <rect className="f-s" x="18" y="37" width="12" height="7" rx="3.500" />
    <rect className="f-a" x="4" y="18" width="7" height="12" rx="3.500" />
    <rect className="f-a" x="37" y="18" width="7" height="12" rx="3.500" />
    <circle className="f-t" cx="24" cy="24" r="11" />
  </>,
  referral: <>
    <circle className="f-p" cx="18" cy="15" r="7" />
    <path className="f-p" d="M5 40a13 13 0 0126 0z" />
    <circle className="f-a" cx="35" cy="26" r="9" />
    <path className="s-n" strokeWidth="3.200" d="M35 21.500v9M30.500 26h9" />
  </>,
  skills: <>
    <path className="f-s" d="M24 4l19.500 14.200-7.500 23H12l-7.500-23z" />
    <path className="f-p" d="M24 11l10.500 9-6 15.500h-10L13 22z" />
    <circle className="f-w" cx="24" cy="24" r="2.600" />
  </>,
  esg: <>
    <path className="f-g" d="M8 40C6 21 16 7 42 6c1 22-9 34-27 33z" />
    <path className="s-n" strokeWidth="3" d="M9 41C13 30 21 21 31 16" />
  </>,
  equity: <>
    <circle className="f-b" cx="22" cy="26" r="17" />
    <path className="f-a" d="M26 22V5a17 17 0 0117 17z" />
  </>,
  recycle: <>
    <rect className="f-n" x="18" y="5" width="12" height="6" rx="3" />
    <rect className="f-n" x="7" y="9.500" width="34" height="5.500" rx="2.750" />
    <path className="f-k" d="M10.500 17h27l-1.800 21.500a4 4 0 01-4 3.500H16.300a4 4 0 01-4-3.500z" />
    <rect className="f-w" x="17.500" y="22" width="3.200" height="14" rx="1.600" />
    <rect className="f-w" x="27.300" y="22" width="3.200" height="14" rx="1.600" />
  </>,
  phone: <>
    <path className="f-t" d="M14.500 5.500c-4 1.200-7 5-6 10.500 2.600 14 13.500 24.900 27.500 27.500 5.500 1 9.300-2 10.500-6l-9-7.500-6 3.500c-4.600-2.200-8.300-5.900-10.500-10.500l3.500-6z" transform="translate(-2.500 -1.500)" />
    <path className="s-a" strokeWidth="3.200" d="M29 7a12 12 0 0112 12M29 14a5 5 0 015 5" />
  </>,
  iot: <>
    <path className="s-k" strokeWidth="3" d="M17 5v8M24 5v8M31 5v8M17 35v8M24 35v8M31 35v8M5 17h8M5 24h8M5 31h8M35 17h8M35 24h8M35 31h8" />
    <rect className="f-n" x="11" y="11" width="26" height="26" rx="6" />
    <rect className="f-t" x="18" y="18" width="12" height="12" rx="3" />
  </>,
  studio: <>
    <rect className="f-s" x="5" y="13" width="26" height="26" rx="6" />
    <circle className="f-w" cx="18" cy="26" r="5" />
    <path className="f-a" d="M22 30L37.500 8.500a3.600 3.600 0 016 4.200L28 34z" />
    <path className="f-n" d="M22 30l6 4-8.500 3z" />
  </>,
  apps: <>
    <circle className="f-c" cx="14" cy="14" r="8" />
    <rect className="f-t" x="26" y="6" width="16" height="16" rx="4.500" />
    <path className="f-a" d="M14 25l9 16H5z" />
    <path className="f-p" d="M34 25l9 9-9 9-9-9z" />
  </>,
  todo: <>
    <path className="f-a" d="M7 12a6 6 0 016-6h22a6 6 0 016 6v17L30 42H13a6 6 0 01-6-6z" />
    <path className="f-n" d="M41 29H34a4 4 0 00-4 4v9z" />
    <path className="s-n" strokeWidth="4" d="M15 22l5.500 5.500L31 16" />
  </>,
  spreadsheet: <>
    <rect className="f-g" x="5" y="7" width="38" height="34" rx="7" />
    <path className="f-n" d="M12 7h24a7 7 0 017 7v3H5v-3a7 7 0 017-7z" />
    <path className="s-w butt" strokeWidth="2.400" d="M18 17v24M5 25h38M5 33h38M31 17v24" />
  </>,
  knowledge: <>
    <path className="f-p" d="M23 12C17.500 8.500 11 8 4 10v27c7-2 13.500-1.500 19 2z" />
    <path className="f-t" d="M25 12c5.500-3.500 12-4 19-2v27c-7-2-13.500-1.500-19 2z" />
    <path className="f-c" d="M32 8.200l6 .300V22l-3-2.500-3 2.500z" />
  </>,
  settings: <>
    <rect className="f-k" x="5" y="10" width="38" height="4" rx="2" />
    <rect className="f-k" x="5" y="22" width="38" height="4" rx="2" />
    <rect className="f-k" x="5" y="34" width="38" height="4" rx="2" />
    <circle className="f-t" cx="32" cy="12" r="5.500" />
    <circle className="f-a" cx="15" cy="24" r="5.500" />
    <circle className="f-c" cx="27" cy="36" r="5.500" />
  </>,
};

/** Launcher icon for an app id; unknown ids fall back to the generic "apps" mark. */
export const AppIcon = ({ id, size = 46 }) => (
  <svg className="app-glyph" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">{GLYPHS[id] ?? GLYPHS.apps}</svg>
);

export const APP_ICON_IDS = Object.keys(GLYPHS);
