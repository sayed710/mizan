/** Current company ID, defaulting to the main company before initialization. */
export const currentCompany = (db) => db.settings?.current_company_id ?? 1;
