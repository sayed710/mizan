// Who is signed in, and which apps they may open (mirrors the Home screen's tile filter).

/** True when `appId` is installed and, for a user restricted to some apps, one of theirs. */
export function appOpen(db, user, appId) {
  if (appId === 'settings') return true;
  if ((db.settings?.uninstalled ?? []).includes(appId)) return false;
  return user?.isAdmin === true || !user?.apps || user.apps.includes(appId);
}

/** The employee linked to the signed-in login (hr.employee.user_login), if any. */
export const myEmployeeId = (db, user) => (user ? (db.records['hr.employee'] ?? []).find((e) => e.user_login === user.login)?.id ?? null : null);
