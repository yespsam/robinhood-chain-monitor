const TWITTER_EPOCH_MS = 1_288_834_974_657n;
const SNOWFLAKE_TIME_TOLERANCE_MS = 2_000;
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "noscript"]);

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return String(value || "").replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, key) => {
    if (key[0] !== "#") return named[key.toLowerCase()] ?? entity;
    const hexadecimal = key[1]?.toLowerCase() === "x";
    const number = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(number) || number < 0 || number > 0x10ffff) return entity;
    try { return String.fromCodePoint(number); }
    catch { return entity; }
  });
}

function tagEnd(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function rawTextClosingTag(html, tag, start) {
  let cursor = start;
  while (cursor < html.length) {
    const candidate = html.indexOf("</", cursor);
    if (candidate < 0) return -1;
    const name = html.slice(candidate + 2, candidate + 2 + tag.length);
    const boundary = html[candidate + 2 + tag.length] || "";
    if (name.length === tag.length
      && name.toLowerCase() === tag
      && (!boundary || /[\s>]/.test(boundary))) return candidate;
    cursor = candidate + 2;
  }
  return -1;
}

function attributes(raw) {
  const result = Object.create(null);
  let index = 0;
  while (index < raw.length) {
    while (/\s/.test(raw[index] || "")) index += 1;
    if (index >= raw.length || raw[index] === "/") break;
    const nameMatch = raw.slice(index).match(/^([^\s=/>]+)/);
    if (!nameMatch) throw new Error("X direct HTML contains a malformed attribute");
    const name = nameMatch[1].toLowerCase();
    index += nameMatch[1].length;
    while (/\s/.test(raw[index] || "")) index += 1;
    let value = "";
    if (raw[index] === "=") {
      index += 1;
      while (/\s/.test(raw[index] || "")) index += 1;
      const quote = raw[index];
      if (quote === '"' || quote === "'") {
        const end = raw.indexOf(quote, index + 1);
        if (end < 0) throw new Error("X direct HTML contains an unterminated attribute");
        value = raw.slice(index + 1, end);
        index = end + 1;
      } else {
        const valueMatch = raw.slice(index).match(/^[^\s/>]+/);
        if (!valueMatch) throw new Error("X direct HTML contains an empty unquoted attribute");
        value = valueMatch[0];
        index += value.length;
      }
    }
    if (Object.hasOwn(result, name)) throw new Error(`X direct HTML repeats attribute ${name}`);
    result[name] = decodeHtml(value);
  }
  return result;
}

function parseHtml(html) {
  const root = { tag: "#document", attrs: Object.create(null), children: [], parent: null };
  const stack = [root];
  let position = 0;
  while (position < html.length) {
    const start = html.indexOf("<", position);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      position = end < 0 ? html.length : end + 3;
      continue;
    }
    const end = tagEnd(html, start);
    if (end < 0) throw new Error("X direct HTML contains an unterminated tag");
    const raw = html.slice(start + 1, end);
    if (/^\s*[!?]/.test(raw)) {
      position = end + 1;
      continue;
    }
    const closing = /^\s*\//.test(raw);
    const nameMatch = raw.match(/^\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (!nameMatch) {
      position = end + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    if (closing) {
      let matching = stack.length - 1;
      while (matching > 0 && stack[matching].tag !== tag) matching -= 1;
      if (matching > 0) stack.length = matching;
      position = end + 1;
      continue;
    }

    const attributeSource = raw.slice(nameMatch.index + nameMatch[0].length);
    const node = {
      tag,
      attrs: attributes(attributeSource),
      children: [],
      parent: stack.at(-1),
    };
    stack.at(-1).children.push(node);
    const selfClosing = /\/\s*$/.test(raw) || VOID_ELEMENTS.has(tag);
    if (RAW_TEXT_ELEMENTS.has(tag) && !selfClosing) {
      // X SSR responses contain hundreds of kilobytes of JSON/JavaScript.
      // Lowercasing the entire document for every official account dominated
      // the monitor's main thread and starved BSC timers. Compare only the few
      // bytes around candidate closing tags instead.
      const closeStart = rawTextClosingTag(html, tag, end + 1);
      if (closeStart < 0) throw new Error(`X direct HTML contains an unterminated ${tag} element`);
      const closeEnd = tagEnd(html, closeStart);
      if (closeEnd < 0) throw new Error(`X direct HTML contains an unterminated ${tag} closing tag`);
      position = closeEnd + 1;
      continue;
    }
    if (!selfClosing) stack.push(node);
    position = end + 1;
  }
  return root;
}

function descendants(root, predicate, { skip = () => false } = {}) {
  const found = [];
  const visit = (node) => {
    for (const child of node.children) {
      if (skip(child)) continue;
      if (predicate(child)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function hasScope(node) {
  return Object.hasOwn(node.attrs, "itemscope");
}

function propertyValues(scope, property) {
  return descendants(scope, (node) => node.tag === "meta" && node.attrs.itemprop === property, {
    skip: (node) => node !== scope && (node.tag === "article" || hasScope(node)),
  }).map((node) => node.attrs.content).filter((value) => value !== undefined);
}

function oneProperty(scope, property) {
  const values = propertyValues(scope, property);
  if (values.length !== 1) throw new Error(`X direct ${scope.attrs.itemtype || scope.tag} must contain exactly one ${property}`);
  return values[0];
}

function exactHandle(value, expectedHandle) {
  return typeof value === "string" && value.toLowerCase() === expectedHandle.toLowerCase();
}

function exactXUrl(value, expectedPath) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "x.com"
      && !url.port
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.toLowerCase().replace(/\/$/, "") === expectedPath.toLowerCase().replace(/\/$/, "");
  } catch {
    return false;
  }
}

function assertDecimalId(value, label) {
  if (!/^[1-9]\d{0,19}$/.test(value || "") || BigInt(value) > (1n << 64n) - 1n) {
    throw new Error(`X direct ${label} is not a valid decimal ID`);
  }
  return value;
}

function snowflakeTimestamp(id) {
  const milliseconds = (BigInt(id) >> 22n) + TWITTER_EPOCH_MS;
  const number = Number(milliseconds);
  if (!Number.isSafeInteger(number)) throw new Error("X direct tweet Snowflake timestamp is out of range");
  const date = new Date(number);
  if (!Number.isFinite(date.getTime())) throw new Error("X direct tweet Snowflake timestamp is invalid");
  return date;
}

function publishedTimestamp(value, id) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value || "")) {
    throw new Error("X direct tweet datePublished must be an ISO UTC timestamp");
  }
  const published = new Date(value);
  const snowflake = snowflakeTimestamp(id);
  if (!Number.isFinite(published.getTime())
    || Math.abs(published.getTime() - snowflake.getTime()) > SNOWFLAKE_TIME_TOLERANCE_MS) {
    throw new Error("X direct tweet datePublished does not match its Snowflake ID");
  }
  return published.toISOString();
}

function directAuthorScopes(post) {
  return descendants(post, (node) => node.attrs.itemprop === "author"
    && node.attrs.itemtype === "https://schema.org/Person"
    && hasScope(node), {
    skip: (node) => node.tag === "article",
  });
}

function interactionCounts(post) {
  const scopes = descendants(post, (node) => node.attrs.itemtype === "https://schema.org/InteractionCounter" && hasScope(node), {
    skip: (node) => node.tag === "article",
  });
  const values = new Map();
  for (const scope of scopes) {
    const name = oneProperty(scope, "name");
    const raw = oneProperty(scope, "userInteractionCount");
    if (!/^\d+$/.test(raw)) throw new Error(`X direct ${name} interaction count is invalid`);
    const count = Number(raw);
    if (!Number.isSafeInteger(count)) throw new Error(`X direct ${name} interaction count is unsafe`);
    if (values.has(name) && values.get(name) !== count) throw new Error(`X direct ${name} interaction count conflicts`);
    values.set(name, count);
  }
  return values;
}

function expandedUrls(post) {
  const urls = [];
  for (const node of descendants(post, (candidate) => candidate.tag === "a" && candidate.attrs.href, {
    skip: (candidate) => candidate.tag === "article",
  })) {
    try {
      const url = new URL(node.attrs.href);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (["x.com", "twitter.com"].includes(host) || host.endsWith(".twimg.com")) continue;
      urls.push(url.href);
    } catch { /* Reject malformed links from evidence without rejecting the verified post. */ }
  }
  return [...new Set(urls)];
}

function parsePost(post, expectedHandle, profileUserId) {
  if (post.tag !== "article" || post.attrs.itemprop !== "hasPart" || !hasScope(post)) {
    throw new Error("X direct SocialMediaPosting must be a top-level scoped article");
  }
  const id = assertDecimalId(post.attrs["data-tweet-id"], "data-tweet-id");
  if (!exactXUrl(post.attrs.itemid, `/i/status/${id}`)) throw new Error("X direct tweet itemID conflicts with data-tweet-id");
  if (oneProperty(post, "identifier") !== id) throw new Error("X direct tweet identifier conflicts with data-tweet-id");
  const canonicalUrl = oneProperty(post, "url");
  if (!exactXUrl(canonicalUrl, `/${expectedHandle}/status/${id}`)) throw new Error("X direct tweet URL conflicts with its ID or expected handle");
  const text = oneProperty(post, "articleBody").trim();
  if (!text) throw new Error("X direct tweet articleBody is empty");
  const createdAt = publishedTimestamp(oneProperty(post, "datePublished"), id);

  const authors = directAuthorScopes(post);
  if (authors.length !== 1) throw new Error("X direct tweet must contain exactly one direct author");
  const author = authors[0];
  const authorId = assertDecimalId(oneProperty(author, "identifier"), "author identifier");
  const handle = oneProperty(author, "alternateName");
  const authorUrl = oneProperty(author, "url");
  const authorName = oneProperty(author, "name").trim();
  if (authorId !== profileUserId || !exactHandle(handle, expectedHandle)) throw new Error("X direct tweet author does not match the verified profile");
  if (!exactXUrl(authorUrl, `/${expectedHandle}`)) throw new Error("X direct tweet author URL does not match the expected handle");
  if (!authorName) throw new Error("X direct tweet author name is empty");

  const interactions = interactionCounts(post);
  const evidenceUrls = expandedUrls(post);
  return {
    id,
    text,
    createdAt,
    authorName,
    handle,
    xUserId: profileUserId,
    authorId,
    replies: interactions.get("Replies") ?? null,
    reposts: interactions.get("Retweets") ?? null,
    likes: interactions.get("Likes") ?? null,
    url: `https://x.com/${expectedHandle}/status/${id}`,
    isReply: false,
    ...(evidenceUrls.length ? { expandedUrls: evidenceUrls } : {}),
  };
}

export function parseXDirectTimeline(html, expectedHandle, expectedUserId = null) {
  if (typeof html !== "string" || !html.trim()) throw new TypeError("X direct timeline HTML must be a non-empty string");
  if (typeof expectedHandle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(expectedHandle)) {
    throw new TypeError("X direct expectedHandle must be a bare valid X handle");
  }
  if (expectedUserId !== null && expectedUserId !== undefined) assertDecimalId(String(expectedUserId), "expected user ID");

  const document = parseHtml(html);
  const profiles = descendants(document, (node) => node.attrs.itemtype === "https://schema.org/ProfilePage" && hasScope(node));
  if (profiles.length !== 1) throw new Error("X direct HTML must contain exactly one ProfilePage");
  const profile = profiles[0];
  const entities = descendants(profile, (node) => node.attrs.itemprop === "mainEntity"
    && node.attrs.itemtype === "https://schema.org/Person"
    && hasScope(node)).filter((entity) => {
      for (let ancestor = entity.parent; ancestor && ancestor !== profile; ancestor = ancestor.parent) {
        if (ancestor.tag === "article" || ancestor.attrs.itemtype === "https://schema.org/SocialMediaPosting") return false;
      }
      return true;
    });
  if (entities.length !== 1) throw new Error("X direct ProfilePage must contain exactly one Person mainEntity");
  const entity = entities[0];
  const profileUserId = assertDecimalId(oneProperty(entity, "identifier"), "profile user ID");
  const profileHandle = oneProperty(entity, "alternateName");
  if (!exactHandle(profileHandle, expectedHandle)) throw new Error("X direct ProfilePage handle does not match expectedHandle");
  if (!exactXUrl(oneProperty(entity, "url"), `/${expectedHandle}`)) throw new Error("X direct ProfilePage URL does not match expectedHandle");
  if (expectedUserId !== null && expectedUserId !== undefined && profileUserId !== String(expectedUserId)) {
    throw new Error("X direct ProfilePage user ID does not match expectedUserId");
  }

  const heads = descendants(document, (node) => node.tag === "head");
  if (heads.length !== 1) throw new Error("X direct document must contain exactly one head element");
  const canonicalLinks = descendants(heads[0], (node) => node.tag === "link"
    && String(node.attrs.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  if (canonicalLinks.length !== 1 || !exactXUrl(canonicalLinks[0].attrs.href, `/${expectedHandle}`)) {
    throw new Error("X direct document canonical URL does not match expectedHandle");
  }

  const postings = descendants(profile, (node) => node.attrs.itemtype === "https://schema.org/SocialMediaPosting" && hasScope(node));
  const topLevel = postings.filter((post) => {
    for (let ancestor = post.parent; ancestor && ancestor !== profile; ancestor = ancestor.parent) {
      if (ancestor.tag === "article" || ancestor.attrs.itemtype === "https://schema.org/SocialMediaPosting") return false;
    }
    return true;
  });
  if (!topLevel.length) throw new Error("X direct ProfilePage returned no top-level SocialMediaPosting articles");
  const tweets = topLevel.map((post) => parsePost(post, expectedHandle, profileUserId));
  const ids = new Set();
  for (const tweet of tweets) {
    if (ids.has(tweet.id)) throw new Error("X direct timeline repeats a top-level tweet ID");
    ids.add(tweet.id);
  }
  return tweets;
}

export const parseXDirectTimelineHtml = parseXDirectTimeline;
