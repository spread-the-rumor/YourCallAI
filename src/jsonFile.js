// Atomic JSON file persistence: temp-file + rename, writes serialized through one
// in-flight promise chain, forgiving reads. Shared by the meeting store and settings.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class JsonFile {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
    this.chain = Promise.resolve();
  }

  async read() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : structuredClone(this.fallback);
    } catch {
      return structuredClone(this.fallback);
    }
  }

  // fn(data) mutates or returns new data; serialized so concurrent updates never interleave.
  update(fn) {
    const run = async () => {
      const data = await this.read();
      const next = (await fn(data)) || data;
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
      await fsp.rename(tmp, this.filePath);
      return next;
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
}

module.exports = { JsonFile };
