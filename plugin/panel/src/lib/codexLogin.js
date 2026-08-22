export function codexLoginCommands({ codexHome } = {}) {
  if (!codexHome) return { powershell: '', posix: '' };
  const path = String(codexHome);
  return {
    powershell: `$env:CODEX_HOME='${path.replace(/'/g, "''")}'; codex login`,
    posix: `CODEX_HOME='${path.replace(/'/g, "'\\''")}' codex login`,
  };
}

export function codexLoginCommand({ codexHome, platformId } = {}) {
  if (!codexHome) return '';
  const commands = codexLoginCommands({ codexHome });
  return String(platformId || '').startsWith('windows')
    ? commands.powershell
    : commands.posix;
}
