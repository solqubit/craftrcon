// Copies text to the clipboard (browser only). Uses the async Clipboard API
// where the page may (HTTPS or localhost) and falls back to a hidden textarea
// and execCommand('copy') on plain-HTTP panels. Resolves true when copied.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not allowed here (insecure origin, permissions): try the old way.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  const focused = document.activeElement;
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus?.();
  }
}
