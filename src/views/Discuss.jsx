import { useEffect, useRef, useState } from 'react';
import { create, messagesOf, postNote, search } from '../orm.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';
import { Avatar } from '../ui.jsx';

/** Team chat: channels are records, messages reuse the chatter store (newest last). */
export function Discuss() {
  const db = useDb();
  const channels = search(db, 'discuss.channel');
  const [active, setActive] = useState(channels[0]?.id ?? null);
  const [text, setText] = useState('');
  const end = useRef(null);
  const messages = active ? [...messagesOf(db, 'discuss.channel', active)].reverse() : [];
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, active]);

  const send = () => {
    if (!text.trim() || !active) return;
    commit(postNote(getDb(), 'discuss.channel', active, text.trim()));
    setText('');
  };
  const addChannel = () => {
    const name = prompt(t('Channel Name'));
    if (!name?.trim()) return;
    const res = create(getDb(), 'discuss.channel', { name: name.trim() });
    commit(res.db);
    setActive(res.id);
  };
  const channel = channels.find((c) => c.id === active);

  return (
    <main className="discuss">
      <aside className="discuss-side">
        <div className="discuss-side-head">
          <h2>{t('Channels')}</h2>
          <button type="button" className="round" aria-label={t('New')} onClick={addChannel}>+</button>
        </div>
        <ul>
          {channels.map((c) => (
            <li key={c.id}>
              <button type="button" aria-current={c.id === active ? 'true' : undefined} onClick={() => setActive(c.id)}># {c.name}</button>
            </li>
          ))}
        </ul>
        <a className="link" href="#/discuss/activities">{t('Activities')} →</a>
      </aside>
      <section className="discuss-thread" aria-label={channel?.name}>
        <header><h1># {channel?.name}</h1><span className="muted">{channel?.description}</span></header>
        <ol className="messages">
          {messages.map((m) => (
            <li key={m.id} className={m.kind}>
              <Avatar name={m.author} size={34} />
              <div>
                <div className="msg-meta"><b>{m.author}</b> <time dateTime={m.date}>{new Date(m.date).toLocaleString()}</time></div>
                <div className="msg-body">{m.body}</div>
              </div>
            </li>
          ))}
          <li ref={end} aria-hidden="true" />
        </ol>
        <div className="discuss-compose">
          <textarea value={text} placeholder={`${t('Message')} #${channel?.name ?? ''}…`} aria-label={t('Message')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button type="button" className="btn primary" disabled={!text.trim()} onClick={send}>{t('Send')}</button>
        </div>
      </section>
    </main>
  );
}
