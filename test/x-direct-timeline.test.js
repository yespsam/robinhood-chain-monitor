import test from "node:test";
import assert from "node:assert/strict";
import { parseXDirectTimeline, parseXDirectTimelineHtml } from "../src/x-direct-timeline.js";

const HANDLE = "fourdotmemezh";
const USER_ID = "1816036559864619011";
const FIRST_ID = "2085019715429380511";
const FIRST_DATE = "2026-08-05T15:06:52.000Z";
const SECOND_ID = "2085018078040236335";
const SECOND_DATE = "2026-08-05T15:00:22.000Z";

function person({ handle = HANDLE, userId = USER_ID, name = "Four.meme-華語", itemProp = "author" } = {}) {
  return `<div hidden itemProp="${itemProp}" itemScope itemType="https://schema.org/Person">
    <meta content="${userId}" itemProp="identifier">
    <meta content="${handle}" itemProp="alternateName">
    <meta content="https://x.com/${handle}" itemProp="url">
    <meta content="${name}" itemProp="name">
  </div>`;
}

function interaction(name, count) {
  return `<div hidden itemProp="interactionStatistic" itemScope itemType="https://schema.org/InteractionCounter">
    <meta content="${name}" itemProp="name">
    <meta content="${count}" itemProp="userInteractionCount">
  </div>`;
}

function posting({
  id = FIRST_ID,
  date = FIRST_DATE,
  handle = HANDLE,
  userId = USER_ID,
  authorHandle = handle,
  authorUserId = userId,
  body = "Royalty &amp; V2 mode is live",
  itemId = `https://x.com/i/status/${id}`,
  identifier = id,
  url = `https://x.com/${handle}/status/${id}`,
  embedded = "",
} = {}) {
  return `<article data-tweet-id="${id}" itemID="${itemId}" itemScope itemProp="hasPart" itemType="https://schema.org/SocialMediaPosting">
    <meta content="${identifier}" itemProp="identifier">
    <meta content="${date}" itemProp="datePublished">
    <meta content="${url}" itemProp="url">
    <meta content="${body}" itemProp="articleBody">
    ${person({ handle: authorHandle, userId: authorUserId })}
    ${interaction("Replies", 3)}
    ${interaction("Retweets", 8)}
    ${interaction("Likes", 55)}
    <a href="https://github.com/Four-Meme/contracts-v2">source</a>
    <a href="https://x.com/${handle}/status/${id}/likes">likes</a>
    ${embedded}
  </article>`;
}

function timeline({
  profileHandle = HANDLE,
  profileUserId = USER_ID,
  canonicalHandle = profileHandle,
  posts = [posting()],
  extraProfiles = "",
} = {}) {
  return `<!doctype html><html><head>
    <link rel="canonical" href="https://x.com/${canonicalHandle}">
    <script>const bait = '<article itemType="https://schema.org/SocialMediaPosting">fake</article>';</script>
  </head><body>
    <div itemScope itemType="https://schema.org/ProfilePage">
      <div itemProp="mainEntity" itemScope itemType="https://schema.org/Person">
        <meta content="https://x.com/${profileHandle}" itemProp="url">
        <meta content="${profileUserId}" itemProp="identifier">
        <meta content="Four.meme-華語" itemProp="name">
        <meta content="${profileHandle}" itemProp="alternateName">
        <div itemProp="image" itemScope itemType="https://schema.org/ImageObject">
          <meta content="https://pbs.twimg.com/avatar.jpg" itemProp="url">
        </div>
      </div>
      <ul>${posts.map((post) => `<li>${post}</li>`).join("")}</ul>
    </div>
    ${extraProfiles}
  </body></html>`;
}

test("strictly parses verified ProfilePage top-level posts into the existing tweet schema", () => {
  const embedded = `<article data-tweet-id="9999999999999999999">
    ${person({ handle: "attacker", userId: "999", itemProp: "author" })}
    <meta content="malicious embedded repost" itemProp="articleBody">
    <a href="https://evil.example/payload">payload</a>
  </article>`;
  const html = timeline({
    posts: [
      posting({ embedded }),
      posting({ id: SECOND_ID, date: SECOND_DATE, body: "Tax Token mode is live" }),
    ],
  });
  const tweets = parseXDirectTimeline(html, HANDLE, USER_ID);
  assert.equal(parseXDirectTimelineHtml, parseXDirectTimeline);
  assert.deepEqual(tweets, [
    {
      id: FIRST_ID,
      text: "Royalty & V2 mode is live",
      createdAt: FIRST_DATE,
      authorName: "Four.meme-華語",
      handle: HANDLE,
      xUserId: USER_ID,
      authorId: USER_ID,
      replies: 3,
      reposts: 8,
      likes: 55,
      url: `https://x.com/${HANDLE}/status/${FIRST_ID}`,
      isReply: false,
      expandedUrls: ["https://github.com/Four-Meme/contracts-v2"],
    },
    {
      id: SECOND_ID,
      text: "Tax Token mode is live",
      createdAt: SECOND_DATE,
      authorName: "Four.meme-華語",
      handle: HANDLE,
      xUserId: USER_ID,
      authorId: USER_ID,
      replies: 3,
      reposts: 8,
      likes: 55,
      url: `https://x.com/${HANDLE}/status/${SECOND_ID}`,
      isReply: false,
      expandedUrls: ["https://github.com/Four-Meme/contracts-v2"],
    },
  ]);
  assert.equal(tweets.some(({ id }) => id === "9999999999999999999"), false);
  assert.equal(tweets.some(({ expandedUrls = [] }) => expandedUrls.includes("https://evil.example/payload")), false);
});

test("uses the ProfilePage user ID when expectedUserId is omitted", () => {
  assert.equal(parseXDirectTimeline(timeline(), HANDLE)[0].id, FIRST_ID);
});

test("rejects the wrong profile handle, canonical URL, or immutable user ID", () => {
  assert.throws(() => parseXDirectTimeline(timeline({ profileHandle: "fourdotmemezh_" }), HANDLE), /handle does not match/);
  assert.throws(() => parseXDirectTimeline(timeline({ canonicalHandle: "fourdotmemezh_" }), HANDLE), /canonical URL/);
  assert.throws(() => parseXDirectTimeline(timeline(), HANDLE, "999"), /user ID does not match/);
});

test("rejects a top-level post authored by a different handle or user ID", () => {
  assert.throws(() => parseXDirectTimeline(timeline({ posts: [posting({ authorHandle: "attacker" })] }), HANDLE), /author does not match/);
  assert.throws(() => parseXDirectTimeline(timeline({ posts: [posting({ authorUserId: "999" })] }), HANDLE), /author does not match/);
});

test("rejects every conflicting tweet identity field", () => {
  const cases = [
    posting({ itemId: `https://x.com/i/status/${SECOND_ID}` }),
    posting({ identifier: SECOND_ID }),
    posting({ url: `https://x.com/${HANDLE}/status/${SECOND_ID}` }),
    posting({ url: `https://x.com/attacker/status/${FIRST_ID}` }),
  ];
  for (const post of cases) assert.throws(() => parseXDirectTimeline(timeline({ posts: [post] }), HANDLE), /conflicts/);
});

test("rejects a datePublished value that disagrees with the tweet Snowflake", () => {
  assert.throws(
    () => parseXDirectTimeline(timeline({ posts: [posting({ date: "2026-08-05T14:06:52.000Z" })] }), HANDLE),
    /does not match its Snowflake ID/,
  );
});

test("rejects duplicate top-level IDs and non-article SocialMediaPosting scopes", () => {
  assert.throws(
    () => parseXDirectTimeline(timeline({ posts: [posting(), posting()] }), HANDLE),
    /repeats a top-level tweet ID/,
  );
  const fake = posting().replace(/^<article/, "<div").replace(/<\/article>$/, "</div>");
  assert.throws(() => parseXDirectTimeline(timeline({ posts: [fake] }), HANDLE), /must be a top-level scoped article/);
});

test("rejects duplicate ProfilePage identities and malformed expected handles", () => {
  const duplicate = `<div itemScope itemType="https://schema.org/ProfilePage"></div>`;
  assert.throws(() => parseXDirectTimeline(timeline({ extraProfiles: duplicate }), HANDLE), /exactly one ProfilePage/);
  assert.throws(() => parseXDirectTimeline(timeline(), "@fourdotmemezh"), /bare valid X handle/);
});

test("does not accept a body-injected canonical link or nested mainEntity as page identity", () => {
  const bodyCanonical = timeline().replace(
    `<link rel="canonical" href="https://x.com/${HANDLE}">`,
    "",
  ).replace("</body>", `<link rel="canonical" href="https://x.com/${HANDLE}"></body>`);
  assert.throws(() => parseXDirectTimeline(bodyCanonical, HANDLE), /canonical URL/);

  const nestedEntity = `<article><div itemProp="mainEntity" itemScope itemType="https://schema.org/Person">
    <meta content="https://x.com/${HANDLE}" itemProp="url">
    <meta content="${USER_ID}" itemProp="identifier">
    <meta content="${HANDLE}" itemProp="alternateName">
  </div></article>`;
  const withoutRealEntity = timeline().replace(
    /<div itemProp="mainEntity"[\s\S]*?<\/div>\s*<ul>/,
    `${nestedEntity}<ul>`,
  );
  assert.throws(() => parseXDirectTimeline(withoutRealEntity, HANDLE), /exactly one Person mainEntity/);
});
