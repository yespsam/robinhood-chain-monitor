const $ = selector => document.querySelector(selector);
const panel = $('#squareSettings');
const input = $('#squareApiKey');
const button = $('#squareKeySave');
const feedback = $('#squareKeyFeedback');
let csrfToken = null;
let busy = false;
let stored = false;
let previewBusy = false;
let previewDrafts = [];

const SAFE_ERRORS = new Set([
  '请只粘贴完整的广场 API 密钥，不要包含说明文字或换行。',
  '本机已有密钥。如需更换，请勾选替换确认后重新粘贴。',
  '密钥目录或文件权限异常，未保存。请检查本机配置权限。',
  '页面验证已失效，请刷新后重试', '输入过长，未保存',
  '本机配置暂不可用，无法确认是否保存。请刷新状态后重试。',
]);

function showStatus(data) {
  stored = data.hasSavedFile === true || data.stored === true;
  $('#squareKeyStatus').textContent = data.verified ? '发帖测试通过' : data.stored ? '已保存 · 未验证' : stored ? '密钥文件为空' : '尚未保存';
  $('#squareReplaceRow').hidden = !stored;
  $('#squareReplace').checked = false;
  button.textContent = stored ? '替换本机密钥' : '仅保存到本机';
  feedback.textContent = data.environmentKeyPresent
    ? '检测到环境变量密钥；官方发布工具会优先读取它。本页面只管理本机文件，尚未验证或发布。'
    : data.verified ? `已核对 ${data.publicationTest.author} 的公开测试帖。自动模拟交易继续运行，自动发帖未开启。`
    : data.stored ? '密钥已保存在本机，不回显。自动发布未开启。' : stored ? '本机密钥文件为空，请勾选替换并重新粘贴。' : '请从备忘录复制广场密钥，粘贴到上方输入框。';
  const testLink = $('#squarePublishedTest');
  const link = data.publicationTest?.link;
  const validLink = data.verified === true && /^https:\/\/www\.binance\.com\/zh-CN\/square\/post\/\d+$/.test(link || '');
  testLink.hidden = !validLink;
  if (validLink) testLink.href = link;
  else testLink.removeAttribute('href');
  feedback.dataset.error = 'false';
}

async function api(options) {
  const response = await fetch('/api/square-key', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(SAFE_ERRORS.has(data.error) ? data.error : '配置请求失败，请刷新页面后重试。');
  return data;
}

function showDraft() {
  const draft = previewDrafts[Number($('#squareDraftSelect').value || 0)];
  $('#squarePreviewText').textContent = draft?.text || '';
  $('#squarePreviewText').hidden = !draft?.text;
}

async function refreshPreview() {
  if (previewBusy) return;
  previewBusy = true;
  $('#squarePreviewRefresh').disabled = true;
  $('#squarePreviewStatus').textContent = '正在生成本地草稿…';
  // Never leave an old draft looking current after a failed refresh.
  previewDrafts = []; showDraft(); $('#squareDraftPicker').hidden = true;
  try {
    const response = await fetch('/api/square-preview', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(12000) });
    const data = await response.json();
    if (!response.ok || data.mode !== 'preview_only' || data.publishingEnabled !== false) throw new Error('invalid_preview');
    $('#squarePreviewStatus').textContent = data.reason || '本地预览，未公开发布。';
    previewDrafts = Array.isArray(data.drafts) ? data.drafts : [];
    const select = $('#squareDraftSelect');
    select.replaceChildren(...previewDrafts.map((draft, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = draft.kind === 'system_test' ? '运行测试草稿（不是买入）' : `模拟买入记录 ${draft.tradeId}`;
      return option;
    }));
    $('#squareDraftPicker').hidden = previewDrafts.length < 2;
    showDraft();
  } catch { $('#squarePreviewStatus').textContent = '暂时无法生成草稿，请稍后刷新。没有内容被发布。'; }
  finally { previewBusy = false; $('#squarePreviewRefresh').disabled = false; }
}

async function refreshStatus() {
  if (busy) return;
  busy = true; button.disabled = true;
  try {
    const data = await api();
    csrfToken = data.csrfToken;
    if (!/^[a-f0-9]{64}$/.test(csrfToken || '')) throw new Error('配置请求失败，请刷新页面后重试。');
    showStatus(data);
  } catch {
    csrfToken = null;
    $('#squarePublishedTest').hidden = true;
    $('#squarePublishedTest').removeAttribute('href');
    $('#squareKeyStatus').textContent = '配置暂不可用';
    feedback.textContent = '无法读取本机配置，请刷新页面后重试。';
    feedback.dataset.error = 'true';
  } finally { busy = false; button.disabled = !csrfToken; }
}

$('#squareKeyForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !csrfToken) return;
  if (stored && !$('#squareReplace').checked) {
    feedback.textContent = '如需更换密钥，请先勾选替换确认。';
    feedback.dataset.error = 'true'; return;
  }
  busy = true; button.disabled = true; input.disabled = true;
  // The input is cleared as soon as its local request is constructed. Do not
  // retain the key in UI state, URLs, logs, storage or returned JSON.
  let body = JSON.stringify({ key: input.value, replace: stored && $('#squareReplace').checked });
  input.value = '';
  feedback.textContent = '正在保存到本机…';
  feedback.dataset.error = 'false';
  try {
    const pending = api({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yesp-CSRF': csrfToken }, body });
    body = null;
    showStatus(await pending);
  } catch (error) {
    feedback.textContent = SAFE_ERRORS.has(error.message) ? error.message : '未能确认是否保存。请刷新页面检查状态，不要连续重复提交。';
    feedback.dataset.error = 'true';
    csrfToken = null;
  } finally { body = null; input.value = ''; input.disabled = false; busy = false; button.disabled = !csrfToken; }
});

panel.addEventListener('toggle', () => {
  if (panel.open) { refreshStatus(); refreshPreview(); }
  else input.value = '';
});
function openFromHash() { if (location.hash === '#squareSettings') panel.open = true; }
$('.settings-link').addEventListener('click', () => { panel.open = true; });
window.addEventListener('hashchange', openFromHash);
window.addEventListener('pagehide', () => { input.value = ''; });
$('#squarePreviewRefresh').addEventListener('click', refreshPreview);
$('#squareDraftSelect').addEventListener('change', showDraft);
openFromHash();
