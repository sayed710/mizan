import { read, search, write } from '../orm.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';

const FLOW = [['new', 'To Cook'], ['cooking', 'Cooking'], ['ready', 'Ready']];
const NEXT = { new: 'cooking', cooking: 'ready', ready: 'served' };

/** Kitchen screen: POS orders move To Cook → Cooking → Ready → served (hidden). */
export function Kitchen() {
  const db = useDb();
  const orders = search(db, 'pos.order').filter((o) => (o.kitchen_state ?? 'new') !== 'served');
  const advance = (o) => commit(write(getDb(), 'pos.order', o.id, { kitchen_state: NEXT[o.kitchen_state ?? 'new'] }));
  return (
    <main className="action">
      <div className="control-panel"><h1 className="cp-title">{t('Kitchen Display')}</h1></div>
      <div className="kanban">
        {FLOW.map(([state, label]) => (
          <section key={state} className="column">
            <header className="column-head"><h2>{t(label)}</h2><span className="count">{orders.filter((o) => (o.kitchen_state ?? 'new') === state).length}</span></header>
            {orders.filter((o) => (o.kitchen_state ?? 'new') === state).map((o) => (
              <button key={o.id} type="button" className={`card kds kds-${state}`} onClick={() => advance(o)}>
                <div className="card-head"><strong>{o.name}</strong></div>
                <ul>{o.lines.map((l, i) => <li key={i}><b>{l.qty}×</b> {read(db, 'product', l.product_id)?.name}</li>)}</ul>
                <span className="muted">{t(state === 'ready' ? 'Tap when served' : 'Tap to advance')}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
