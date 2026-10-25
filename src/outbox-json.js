import fs from "node:fs";

const ENTRY_MAPS = new Set([
  "events", "immutableOpenFourSignalOwners", "fourRegistryDeliveryOwners",
]);
const CHUNK_CHARACTERS = 64 * 1024;
const whitespace = (character) => character === " " || character === "\n"
  || character === "\r" || character === "\t";

// Only plain JSON data is supported. Memory overhead is bounded by the largest
// map entry (or other top-level value), not the size of the complete document.
// The unfiltered result necessarily retains the complete parsed object graph.
class JsonCursor {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = "";
    this.position = 0;
    this.finished = false;
  }

  async available() {
    while (this.position === this.buffer.length && !this.finished) {
      const next = await this.iterator.next();
      this.finished = Boolean(next.done);
      this.buffer = next.done ? "" : next.value;
      this.position = 0;
    }
    return this.position < this.buffer.length;
  }

  async skipWhitespace() {
    while (await this.available()) {
      while (this.position < this.buffer.length && whitespace(this.buffer[this.position])) this.position += 1;
      if (this.position < this.buffer.length) return;
    }
  }

  async expect(character) {
    await this.skipWhitespace();
    if (!await this.available() || this.buffer[this.position] !== character) {
      throw new SyntaxError(`Invalid outbox JSON: expected ${JSON.stringify(character)}`);
    }
    this.position += 1;
  }

  async string() {
    await this.skipWhitespace();
    if (!await this.available() || this.buffer[this.position] !== '"') {
      throw new SyntaxError("Invalid outbox JSON: expected property name");
    }
    const pieces = [];
    let escaped = false;
    let opening = true;
    while (await this.available()) {
      const start = this.position;
      while (this.position < this.buffer.length) {
        const character = this.buffer[this.position++];
        if (opening) { opening = false; continue; }
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (character === '"') {
          pieces.push(this.buffer.slice(start, this.position));
          return JSON.parse(pieces.join(""));
        }
      }
      pieces.push(this.buffer.slice(start, this.position));
    }
    throw new SyntaxError("Invalid outbox JSON: unterminated property name");
  }

  async value() {
    await this.skipWhitespace();
    const pieces = [];
    let depth = 0;
    let quoted = false;
    let escaped = false;
    while (await this.available()) {
      const start = this.position;
      while (this.position < this.buffer.length) {
        const character = this.buffer[this.position];
        if (!quoted && depth === 0 && (character === "," || character === "}")) {
          pieces.push(this.buffer.slice(start, this.position));
          return JSON.parse(pieces.join(""));
        }
        this.position += 1;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "{" || character === "[") depth += 1;
        else if (character === "}" || character === "]") depth -= 1;
      }
      pieces.push(this.buffer.slice(start, this.position));
    }
    // JSON.parse validates all primitive, escape, nesting and number syntax.
    // The enclosing object parser additionally requires its closing brace.
    return JSON.parse(pieces.join(""));
  }

  async object(readValue, keep = () => true) {
    await this.expect("{");
    const result = {};
    await this.skipWhitespace();
    if (await this.available() && this.buffer[this.position] === "}") {
      this.position += 1;
      return result;
    }
    while (true) {
      const key = await this.string();
      await this.expect(":");
      const value = await readValue(key);
      if (keep(key)) {
        // Assignment to __proto__ must have JSON.parse's own-property meaning.
        Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true });
      }
      await this.skipWhitespace();
      if (!await this.available()) throw new SyntaxError("Invalid outbox JSON: unterminated object");
      const separator = this.buffer[this.position++];
      if (separator === "}") return result;
      if (separator !== ",") throw new SyntaxError("Invalid outbox JSON: expected object separator");
    }
  }
}

export async function readOutboxJson(file, { eventIds } = {}) {
  if (eventIds !== undefined && (eventIds === null || typeof eventIds === "string"
    || typeof eventIds[Symbol.iterator] !== "function")) throw new TypeError("eventIds must be an iterable of event IDs");
  const selected = eventIds === undefined ? null : new Set(eventIds);
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: CHUNK_CHARACTERS });
  const cursor = new JsonCursor(stream);
  try {
    const result = await cursor.object(async (key) => {
      await cursor.skipWhitespace();
      if (ENTRY_MAPS.has(key) && await cursor.available() && cursor.buffer[cursor.position] === "{") {
        return cursor.object(() => cursor.value(), (id) => key !== "events" || selected === null || selected.has(id));
      }
      return cursor.value();
    });
    await cursor.skipWhitespace();
    if (await cursor.available()) throw new SyntaxError("Invalid outbox JSON: trailing content");
    return result;
  } finally {
    stream.destroy();
  }
}

function* textChunks(text) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_CHARACTERS, text.length);
    // writeFile encodes each yielded string separately. Never split a UTF-16
    // surrogate pair, or a valid non-BMP character would become two U+FFFDs.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff
      && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1;
    yield text.slice(start, end);
    start = end;
  }
}

/** Stream plain JSON outbox data directly into FileHandle.writeFile(). */
export function* outboxJsonChunks(outbox) {
  if (!outbox || typeof outbox !== "object" || Array.isArray(outbox)) {
    throw new TypeError("Outbox must be a JSON object");
  }
  yield "{";
  let first = true;
  for (const key of Object.keys(outbox)) {
    const value = outbox[key];
    const entryMap = ENTRY_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value);
    const encoded = entryMap ? null : JSON.stringify(value);
    if (encoded === undefined) continue;
    if (!first) yield ",";
    first = false;
    yield* textChunks(JSON.stringify(key));
    yield ":";
    if (!entryMap) {
      yield* textChunks(encoded);
      continue;
    }
    yield "{";
    let firstEntry = true;
    for (const id in value) {
      if (!Object.hasOwn(value, id)) continue;
      const entry = JSON.stringify(value[id]);
      if (entry === undefined) continue;
      if (!firstEntry) yield ",";
      firstEntry = false;
      yield* textChunks(JSON.stringify(id));
      yield ":";
      yield* textChunks(entry);
    }
    yield "}";
  }
  yield "}\n";
}
