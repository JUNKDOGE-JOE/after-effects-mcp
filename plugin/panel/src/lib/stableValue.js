export function reconcileStableJsonValue(previous, value) {
  const json = JSON.stringify(value);
  if (previous && previous.json === json) return previous;
  return { json, value };
}
