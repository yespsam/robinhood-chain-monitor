// Official website giwa.io/home links this handle. Mirror data discovers IDs;
// only X's own oEmbed supplies the published text used by the monitor.
export const GIWA_X_USER_ID = "2022226288799518721";
const handle = "GIWA_by_Upbit";
const decode = (text) => String(text || "").replace(/&#(x[0-9a-f]+|\d+);/gi, (_m, n) => {
  const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_m, n) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " })[n]);

export function verifyGiwaOembed(id, oembed, nowMs = Date.now()) {
  if (!/^[1-9]\d{17,19}$/.test(id)) throw new Error("invalid_giwa_x_id");
  const url = `https://x.com/${handle}/status/${id}`;
  if (![`https://x.com/${handle}`, `https://twitter.com/${handle}`].includes(oembed.author_url)
    || ![url, url.replace("x.com/", "twitter.com/")].includes(oembed.url)) throw new Error("giwa_x_author_mismatch");
  const html = String(oembed.html || "");
  if (html.length > 30_000 || !html.includes(`/status/${id}`)) throw new Error("giwa_x_status_mismatch");
  const paragraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  if (!paragraph) throw new Error("giwa_x_text_missing");
  const text = decode(paragraph.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")).trim();
  const timestamp = Number((BigInt(id) >> 22n) + 1288834974657n);
  if (!text || text.length > 10_000 || timestamp > nowMs + 30_000) throw new Error("giwa_x_invalid_payload");
  return { id, url, text, publishedAt: new Date(timestamp).toISOString(), verification: "official_x_oembed", oembed };
}

export async function readGiwaOfficialX(fetchText, previous = [], nowMs = Date.now()) {
  const data = JSON.parse(await fetchText(`https://api.fxtwitter.com/2/profile/id:${GIWA_X_USER_ID}/statuses?count=40`));
  if (data.code !== 200 || !Array.isArray(data.results)) throw new Error("giwa_x_timeline_unavailable");
  const own = data.results.filter((post) => post.type === "status" && post.author?.id === GIWA_X_USER_ID
    && post.author?.screen_name === handle && !post.reposted_by && /^[1-9]\d{17,19}$/.test(post.id))
    .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 3);
  if (!own.length) throw new Error("giwa_x_own_posts_missing");
  const posts = [];
  for (const post of own) {
    const cached = previous.find((old) => old.id === post.id && old.mirrorText === post.text);
    const oembed = cached?.oembed || JSON.parse(await fetchText(`https://publish.x.com/oembed?omit_script=true&url=${encodeURIComponent(`https://x.com/${handle}/status/${post.id}`)}`));
    posts.push({ ...verifyGiwaOembed(post.id, oembed, nowMs), mirrorText: post.text });
  }
  return posts;
}
