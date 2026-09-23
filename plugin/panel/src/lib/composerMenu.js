export function composerMenuLayout(rect, viewport, align = 'left') {
  const margin = 8;
  const gap = 4;
  const width = Math.max(0, viewport.width - margin * 2);
  const minWidth = Math.min(184, width);
  const above = Math.max(0, rect.top - gap - margin);
  const below = Math.max(0, viewport.height - rect.bottom - gap - margin);
  const opensUp = above >= below;
  const left = Math.max(margin, Math.min(
    align === 'right' ? rect.right - minWidth : rect.left,
    viewport.width - margin - minWidth,
  ));
  return {
    position: 'fixed',
    left,
    ...(opensUp
      ? { bottom: viewport.height - rect.top + gap }
      : { top: rect.bottom + gap }),
    minWidth,
    maxWidth: Math.max(0, viewport.width - margin - left),
    maxHeight: Math.min(viewport.height * 0.6, opensUp ? above : below),
  };
}
