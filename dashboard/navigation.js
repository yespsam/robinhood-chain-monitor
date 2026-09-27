// Resolve IDs, never interpret a URL fragment as a selector or HTML.
export function revealHashSection(document, hash) {
  let id;
  try { id = decodeURIComponent(String(hash || '').replace(/^#/, '')); }
  catch { return false; }
  if (!id) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  for (let node = target; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS') node.open = true;
  }
  return true;
}
