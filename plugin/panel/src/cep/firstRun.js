const WIZARD_DONE_KEY = 'ae_mcp_wizard_done';

export function isWizardDone(storage) {
  try {
    return storage.getItem(WIZARD_DONE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

export function markWizardDone(storage) {
  try {
    storage.setItem(WIZARD_DONE_KEY, '1');
  } catch (e) {
    // best-effort persistence
  }
}
