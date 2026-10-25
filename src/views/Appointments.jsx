// Public appointment booking: #/shop/appointments (list with search) and #/shop/appointments/<id> (staff, day, time, details, confirmation).
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { formatDate, money } from '../ui.jsx';

const post = (path, body) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

/** "30 minutes", "1 hour", "1 hour 30 minutes". */
export function durationLabel(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hours = h ? (h === 1 ? t('1 hour') : t('{count} hours', { count: h })) : '';
  const mins = m ? t('{count} minutes', { count: m }) : '';
  return [hours, mins].filter(Boolean).join(' ');
}

const timeLabel = (local) => new Date(`2000-01-01T${local.slice(11, 16)}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

function Avatars({ staff }) {
  return (
    <div className="appt-avatars">
      {staff.map((s) => (s.avatar ? <img key={s.id} src={s.avatar} alt={s.name} title={s.name} /> : <span key={s.id} title={s.name} aria-label={s.name}>{initials(s.name)}</span>))}
    </div>
  );
}

function Where({ type }) {
  return <span className="appt-where">{type.is_online ? <><span aria-hidden="true">🎥</span> {t('Online')}</> : type.location}</span>;
}

/** "Choose your appointment": cards with image, description, location, duration, staff and price. */
function AppointmentList({ types }) {
  const [query, setQuery] = useState('');
  const shown = types.filter((a) => `${a.name} ${a.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section className="appt">
      <div className="appt-head">
        <h1>{t('Choose your appointment')}</h1>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search…')} aria-label={t('Search appointments')} />
      </div>
      <div className="appt-cards">
        {shown.map((a) => (
          <a key={a.id} className="appt-card" href={`#/shop/appointments/${a.id}`}>
            {a.image ? <img src={a.image} alt="" /> : <div className="appt-card-img" aria-hidden="true">{initials(a.name)}</div>}
            <div className="appt-card-body">
              <h2>{a.name}</h2>
              {a.description && <p>{a.description}</p>}
              <p className="muted"><Where type={a} /> · {durationLabel(a.duration)}</p>
              <div className="appt-card-foot">
                <Avatars staff={a.staff} />
                {a.price > 0 && <b>{money(a.price)}</b>}
              </div>
            </div>
          </a>
        ))}
        {!shown.length && <p className="muted">{t('No appointment matches your search.')}</p>}
      </div>
    </section>
  );
}

/** Free slots for the next 14 days from the server (refetched when the staff filter changes). */
function useSlots(typeId, staff, version) {
  const [state, setState] = useState({ slots: null, error: null });
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ slots: null, error: null });
    fetch(`/api/public/appointment/${typeId}/slots?${new URLSearchParams(staff ? { staff } : {})}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setState(d.slots ? { slots: d.slots, error: null } : { slots: [], error: d.error }))
      .catch((e) => { if (e.name !== 'AbortError') setState({ slots: [], error: t('Could not load the availabilities') }); });
    return () => ctrl.abort();
  }, [typeId, staff, version]);
  return state;
}

function DetailsForm({ type, slot, staff, onDone, onBack }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const r = await post('/api/public/book', {
      type_id: type.id, start: slot.start, staff_id: staff ? Number(staff) : null, name: f.get('name'), email: f.get('email'), phone: f.get('phone'),
      answers: type.questions.map((q, i) => ({ question: q.label, answer: f.get(`q${i}`) ?? '' })),
    });
    setBusy(false);
    if (r.ok) onDone(r.data); else setError(r.data.error ?? t('Could not book this slot'));
  };
  return (
    <form className="checkout appt-form" onSubmit={submit}>
      <p><b>{formatDate(slot.start.slice(0, 10), { weekday: 'long', month: 'long', day: 'numeric' })}</b> · {timeLabel(slot.start)}</p>
      <label>{t('Name')}<input name="name" required maxLength={120} autoComplete="name" /></label>
      <label>{t('Email')}<input name="email" type="email" required autoComplete="email" /></label>
      <label>{t('Phone')}<input name="phone" type="tel" autoComplete="tel" /></label>
      {type.questions.map((q, i) => <label key={q.label}>{q.label}<textarea name={`q${i}`} required={q.required} maxLength={2000} /></label>)}
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="appt-actions">
        <button type="button" className="btn" onClick={onBack}>{t('Back')}</button>
        <button type="submit" className="btn primary" disabled={busy}>{t('Confirm Appointment')}</button>
      </div>
    </form>
  );
}

/** One type: staff picker, 14-day strip, time buttons, Continue, details, confirmation. */
function AppointmentPage({ type }) {
  const [staff, setStaff] = useState('');
  const [version, setVersion] = useState(0);
  const { slots, error } = useSlots(type.id, staff, version);
  const [day, setDay] = useState(null);
  const [slot, setSlot] = useState(null);
  const [step, setStep] = useState('pick');
  const [done, setDone] = useState(null);
  const firstOpen = slots?.find((d) => d.times.length)?.date ?? null;
  const current = slots?.find((d) => d.date === (day ?? firstOpen));

  if (done) {
    return (
      <section className="appt appt-done" role="status">
        <h1>{t('Your appointment is booked')}</h1>
        <p><b>{type.name}</b></p>
        <p>{formatDate(done.start.slice(0, 10), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · {timeLabel(done.start)} · {durationLabel(type.duration)}</p>
        {done.meeting_url && <p>{t('Meeting Link')}: <a href={done.meeting_url} target="_blank" rel="noopener noreferrer">{done.meeting_url}</a></p>}
        {!type.is_online && type.location && <p>{type.location}</p>}
        <a className="btn" href="#/shop/appointments">{t('Book another appointment')}</a>
      </section>
    );
  }

  return (
    <section className="appt appt-page">
      <div className="appt-main">
        <a href="#/shop/appointments" className="muted">← {t('All appointments')}</a>
        <h1>{type.name}</h1>
        {step === 'details' && slot ? (
          <DetailsForm type={type} slot={slot} staff={staff} onDone={setDone} onBack={() => { setStep('pick'); setVersion((v) => v + 1); }} />
        ) : (
          <>
            {type.assign_method === 'chosen' && type.staff.length > 0 && (
              <label className="appt-row">{t('With:')}
                <select value={staff} onChange={(e) => { setStaff(e.target.value); setSlot(null); setDay(null); }}>
                  <option value="">{t('No Preference')}</option>
                  {type.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <h2 className="appt-label">{t('Date:')}</h2>
            {!slots ? <p className="muted">…</p> : (
              <div className="appt-days" role="list">
                {slots.map((d) => (
                  <button key={d.date} type="button" role="listitem" className={`appt-day${d.date === current?.date ? ' active' : ''}`} disabled={!d.times.length}
                    aria-pressed={d.date === current?.date} onClick={() => { setDay(d.date); setSlot(null); }}>
                    <small>{formatDate(d.date, { weekday: 'short' })}</small>
                    <b>{formatDate(d.date, { day: 'numeric' })}</b>
                    <small>{formatDate(d.date, { month: 'short' })}</small>
                  </button>
                ))}
              </div>
            )}
            {error && <div className="alert" role="alert">{error}</div>}
            <h2 className="appt-label">{t('Pick a Time')}</h2>
            {slots && !current?.times.length && <p className="muted">{t('No availability in the next 14 days.')}</p>}
            <div className="appt-times">
              {current?.times.map((tm) => (
                <button key={tm.start} type="button" className={`btn${slot?.start === tm.start ? ' primary' : ''}`} aria-pressed={slot?.start === tm.start} onClick={() => setSlot(tm)}>
                  {timeLabel(tm.start)}
                </button>
              ))}
            </div>
            <button type="button" className="btn primary appt-continue" disabled={!slot} onClick={() => setStep('details')}>{t('Continue')}</button>
          </>
        )}
      </div>
      <aside className="appt-side">
        {type.image && <img src={type.image} alt="" />}
        <p><Where type={type} /></p>
        <p>{durationLabel(type.duration)}{type.price > 0 && <> · <b>{money(type.price)}</b></>}</p>
        {type.description && <p className="muted">{type.description}</p>}
        <Avatars staff={type.staff} />
      </aside>
    </section>
  );
}

/** Router for the appointment pages of the public site. */
export function Appointments({ site, route }) {
  if (!route.arg) return <AppointmentList types={site.appointments} />;
  const type = site.appointments.find((a) => String(a.id) === route.arg);
  return type ? <AppointmentPage key={type.id} type={type} /> : <p className="alert">{t('Appointment not found')}</p>;
}
