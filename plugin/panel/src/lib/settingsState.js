export function zcodeModelLocked({ backend, modelSwitchable }) {
  return backend === 'zcode' && modelSwitchable === false;
}

// The DEFAULT model picker (Settings -> "默认模型（打开面板时使用）") is a
// distinct concept from zcodeModelLocked above, which gates the composer's
// mid-session model-switch UI. Changing the default model only affects the
// NEXT session/create call -- it never requires switching models mid-turn --
// so it must not be gated by modelSwitchable/perTurnModelSwitch. It should
// only be locked when there is genuinely nothing to pick from.
export function zcodeDefaultModelLocked({ backend, models }) {
  if (backend !== 'zcode') return false;
  return !Array.isArray(models) || models.length <= 1;
}
