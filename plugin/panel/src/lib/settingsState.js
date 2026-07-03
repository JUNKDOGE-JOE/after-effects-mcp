export function zcodeModelLocked({ backend, modelSwitchable }) {
  return backend === 'zcode' && modelSwitchable === false;
}
