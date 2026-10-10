// Test double for the harness: records every query and can simulate an
// unreachable database. The agent must keep this module and its interface.
export const db = {
  async query(sql, params = []) {
    globalThis.__dbCalls = globalThis.__dbCalls || [];
    globalThis.__dbCalls.push({ sql, params });
    if (globalThis.__dbFail) throw new Error('ECONNREFUSED database unreachable');
    return { rows: [{ id: globalThis.__dbCalls.length }], rowCount: 1 };
  }
};
export default db;
