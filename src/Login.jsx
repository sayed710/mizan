import { useState } from 'react';
import { login } from './store.js';
import { t } from './i18n.js';

export function Login() {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(name.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="brand">Mizan</span>
        <label htmlFor="login">{t('Login')}</label>
        <input id="login" autoComplete="username" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="password">{t('Password')}</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="alert" role="alert">{t(error)}</div>}
        <button type="submit" className="btn primary" disabled={busy}>{t('Log in')}</button>
      </form>
    </main>
  );
}
