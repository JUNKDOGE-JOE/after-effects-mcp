export function copyWizardConfig(copyText, fallbackConfig, selectedConfig) {
  const text = selectedConfig || fallbackConfig || '';
  return copyText ? copyText(text) : undefined;
}
