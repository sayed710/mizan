let actor = null;
/** The signed-in user ({ login, name }) on the client; null in local mode. */
export const setActor = (value) => { actor = value?.login ? { login: value.login, name: value.name ?? value.login } : null; };
export const currentActor = () => actor;

/** The employee linked to a user login, or null. */
export const employeeFor = (db, login) => (login ? (db.records['hr.employee'] ?? []).find((e) => e.user_login === login) ?? null : null);
