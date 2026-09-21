const ok = (value) => ({ ok: true, value });
const err = (error) => ({ ok: false, error });
function reject(control, reason, detail, context) {
  return err(context === void 0 ? { control, reason, detail } : { control, reason, detail, context });
}
const isOk = (r) => r.ok;
const isErr = (r) => !r.ok;
function expectOk(r) {
  if (r.ok) return r.value;
  throw new Error(`expected ok, got rejection: ${JSON.stringify(r.error)}`);
}
export {
  err,
  expectOk,
  isErr,
  isOk,
  ok,
  reject
};
