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

// Locked-state hint copy for the Settings "default model" field. Shows the
// actual model id (e.g. 'mediastorm_glm/deepseek-v4-flash') when known,
// falling back to the old generic wording only when no model id is
// available (e.g. before the CLI config has been read at all).
export function zcodeManagedModelLabel(lang, modelId) {
  const id = String(modelId || '').trim();
  if (!id) {
    return lang === 'en' ? 'Managed by the current ZCode session' : '由 ZCode 当前会话管理';
  }
  return lang === 'en'
    ? 'Current model: ' + id + ' (managed by ZCode configuration)'
    : '当前模型：' + id + '（由 ZCode 配置管理）';
}
