// Taking a survey (every question type, conditional questions, score at the end) and its results analysis.
import { useState } from 'react';
import { read, search } from '../orm.js';
import { choicesOf, submitSurvey, surveyResults, visibleQuestions } from '../models/surveys.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';

const surveyFromUrl = (db, onlyOpen) => {
  const id = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('survey'));
  const all = search(db, 'survey.survey').filter((s) => !onlyOpen || s.stage_id === 'open');
  return read(db, 'survey.survey', id) ?? all[0];
};

/** Input for one question, by type; legacy 'choice'/'rating' behave as single choice / scale. */
function Answer({ q, i, value, set }) {
  const kind = ({ choice: 'single', rating: 'scale' })[q.kind] ?? q.kind ?? 'text';
  if (kind === 'textarea') return <textarea value={value ?? ''} onChange={(e) => set(e.target.value)} />;
  if (kind === 'number') return <input type="number" value={value ?? ''} onChange={(e) => set(e.target.value)} />;
  if (kind === 'date') return <input type="date" value={value ?? ''} onChange={(e) => set(e.target.value)} />;
  if (kind === 'scale') {
    return <div className="row">{choicesOf(q).map((n) => <button key={n} type="button" className={`btn sm ${String(value) === n ? 'primary' : ''}`} aria-pressed={String(value) === n} onClick={() => set(n)}>{n}</button>)}</div>;
  }
  if (kind === 'single') return choicesOf(q).map((c) => <label key={c} className="choice"><input type="radio" name={`q${i}`} checked={value === c} onChange={() => set(c)} /> {c}</label>);
  if (kind === 'multiple') {
    const picked = Array.isArray(value) ? value : [];
    return choicesOf(q).map((c) => (
      <label key={c} className="choice"><input type="checkbox" checked={picked.includes(c)} onChange={(e) => set(e.target.checked ? [...picked, c] : picked.filter((x) => x !== c))} /> {c}</label>
    ));
  }
  return <input value={value ?? ''} onChange={(e) => set(e.target.value)} />;
}

export function SurveyTake() {
  const db = useDb();
  const survey = surveyFromUrl(db, true);
  const [who, setWho] = useState({ name: '', email: '' });
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  if (!survey) return <main className="action"><p className="empty">{t('No open survey.')}</p></main>;
  const reset = () => { setResult(null); setAnswers({}); setWho({ name: '', email: '' }); };
  if (result) {
    const scored = survey.scoring_type && survey.scoring_type !== 'no_scoring' && result.max > 0;
    return (
      <main className="action">
        <div className="sheet survey-done">
          <h2>{t('Thank you!')}</h2>
          <p>{t('Your answers were recorded.')}</p>
          {scored && <p><b>{t('Your score')}: {result.percent}%</b> — {result.passed ? t('Passed') : t('Not passed')}{survey.certification && result.passed ? ` · ${t('Certified')}` : ''}</p>}
          <button type="button" className="btn" onClick={reset}>{t('Answer again')}</button>
        </div>
      </main>
    );
  }
  const submit = (e) => {
    e.preventDefault();
    try {
      const out = submitSurvey(getDb(), survey, { ...who, answers });
      commit(out.db);
      setError(null);
      setResult(out.result);
    } catch (err) {
      setError(err.message);
    }
  };
  const shown = visibleQuestions(survey, answers);
  return (
    <main className="action">
      <form className="sheet survey-form" onSubmit={submit}>
        <h1>{survey.name}</h1>
        {survey.description && <p className="muted">{survey.description}</p>}
        <label>{t('Your name')}<input required value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} /></label>
        <label>{t('Email')}<input type="email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} /></label>
        {survey.questions.map((q, i) => shown.includes(i) && (
          <fieldset key={i}>
            {q.section && <h3>{q.section}</h3>}
            <legend>{i + 1}. {q.question}{q.mandatory ? ' *' : ''}</legend>
            <Answer q={q} i={i} value={answers[i]} set={(v) => setAnswers({ ...answers, [i]: v })} />
          </fieldset>
        ))}
        {error && <div className="alert" role="alert">{t(error)}</div>}
        <button type="submit" className="btn primary">{t('Submit')}</button>
      </form>
    </main>
  );
}

export function SurveyResults() {
  const db = useDb();
  const survey = surveyFromUrl(db, false);
  if (!survey) return <main className="action"><p className="empty">{t('No survey yet.')}</p></main>;
  const results = surveyResults(db, survey);
  return (
    <main className="action">
      <div className="control-panel"><h1 className="cp-title">{survey.name} — {t('Results')}</h1></div>
      <div className="sheet survey-results">
        <p className="muted">{t('Responses')}: {survey.responses ?? 0}</p>
        {results.map((r, i) => (
          <section key={i}>
            <h3>{i + 1}. {r.question} <span className="muted">({r.answered} {t('answered')})</span></h3>
            {r.counts && (
              <table className="list">
                <tbody>
                  {Object.entries(r.counts).map(([c, n]) => (
                    <tr key={c}><td>{c}</td><td className="num">{n}</td><td><span className="bar" style={{ inlineSize: `${r.answered ? (n / r.answered) * 100 : 0}%` }} /></td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {r.kind === 'number' && <p>{t('Average')}: {r.avg ?? '—'} · {t('Minimum')}: {r.min ?? '—'} · {t('Maximum')}: {r.max ?? '—'}</p>}
            {r.texts && <ul>{r.texts.map((x, k) => <li key={k}>{x}</li>)}</ul>}
          </section>
        ))}
      </div>
    </main>
  );
}
