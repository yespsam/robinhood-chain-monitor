const $ = id => document.getElementById(id);
const mintStyles = document.createElement('link'); mintStyles.rel = 'stylesheet'; mintStyles.href = '/mint.css'; document.head.append(mintStyles);
const views = { overview: ['钱包总览', '钱包总览'], history: ['交易记录', '交易记录'], quote: ['兑换 Swap', '兑换代币'], mint: ['创建代币 Mint', '创建代币'], 'custom-call': ['自定义合约', '自定义合约调用'] };
let currentView = 'overview';
function navigate(view) {
  if (!Object.hasOwn(views, view)) return;
  currentView = view;
  document.querySelectorAll('[data-screen]').forEach(node => { node.hidden = node.dataset.screen !== view; });
  document.querySelectorAll('[data-view]').forEach(node => { if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  $('view-name').textContent = views[view][0]; $('page-title').textContent = views[view][1];
  document.dispatchEvent(new CustomEvent('wallet:view', { detail: { view } }));
}
document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => navigate(node.dataset.view)));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); navigate('overview'); });
const drawer = $('settings-drawer');
document.querySelectorAll('[data-open-settings]').forEach(node => node.addEventListener('click', () => drawer.showModal()));
$('close-settings').addEventListener('click', () => drawer.close());
drawer.addEventListener('click', event => { if (event.target === drawer) { const r = drawer.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) drawer.close(); } });
document.addEventListener('wallet:show-settings', () => { if (!drawer.open) drawer.showModal(); });
document.addEventListener('wallet:bound', () => drawer.close());
document.addEventListener('wallet:query-view', () => document.dispatchEvent(new CustomEvent('wallet:current-view', { detail: { view: currentView } })));
