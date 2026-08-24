import fs from "node:fs/promises";
import path from "node:path";

export class Storage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, "state.json");
    this.eventsFile = path.join(dataDir, "events.jsonl");
    this.gmgnFile = path.join(dataDir, "gmgn-baseline.json");
    this.state = { lastBlock: null, lastBlockHash: null, factoryScores: {} };
    this.gmgn = { platforms: [], tokens: {} };
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      this.state = { ...this.state, ...JSON.parse(await fs.readFile(this.stateFile, "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      this.gmgn = JSON.parse(await fs.readFile(this.gmgnFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async append(event) {
    await fs.appendFile(this.eventsFile, `${JSON.stringify(event)}\n`);
  }

  async saveBlock(block, factoryScores) {
    this.state = {
      ...this.state,
      lastBlock: block.number,
      lastBlockHash: block.hash,
      factoryScores: Object.fromEntries(factoryScores),
    };
    const temporary = `${this.stateFile}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
    await fs.rename(temporary, this.stateFile);
  }
}
