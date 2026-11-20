// State that outlives a single tool call.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Chat histories, so that a follow-up question can refer to an earlier answer
 * by id instead of resending it. Kept in memory only: a conversation ends with
 * the server process.
 */
export class ConversationStore {
  #conversations = new Map();
  #limit;

  constructor({ limit = 20 } = {}) {
    this.#limit = limit;
  }

  /** @returns {object[] | undefined} A copy of the stored messages. */
  get(id) {
    const messages = this.#conversations.get(id);
    if (!messages) return undefined;
    // Re-insert so that the most recently used conversation is evicted last.
    this.#conversations.delete(id);
    this.#conversations.set(id, messages);
    return [...messages];
  }

  /** Store `messages` under `id`, or under a new id when none is given. */
  save(id, messages) {
    const key = id ?? `c_${crypto.randomBytes(4).toString('hex')}`;
    this.#conversations.delete(key);
    this.#conversations.set(key, [...messages]);
    while (this.#conversations.size > this.#limit) {
      this.#conversations.delete(this.#conversations.keys().next().value);
    }
    return key;
  }
}

/**
 * Deep Research jobs this plugin started. A job runs on PLaMo's side for
 * minutes and its result stays available for 24 hours, so the ids are written
 * to the plugin's data directory, where a later session can find them.
 */
export class ResearchJobStore {
  #file;
  #projectDir;
  #limit;
  #memory = [];
  #queue = Promise.resolve();

  /**
   * @param {{ dataDir: string | null, projectDir: string, limit?: number }} options
   *   Without a data directory the jobs are remembered for this process only.
   */
  constructor({ dataDir, projectDir, limit = 50 }) {
    this.#file = dataDir ? path.join(dataDir, 'research-jobs.json') : null;
    this.#projectDir = projectDir;
    this.#limit = limit;
  }

  /**
   * Run one operation at a time. Each of them reads the list, changes it and
   * writes it back, so two at once would lose one of the changes.
   */
  #exclusive(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #read() {
    if (!this.#file) return this.#memory;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      return Array.isArray(parsed?.jobs) ? parsed.jobs.filter((job) => typeof job?.id === 'string') : [];
    } catch {
      // No file, or one that cannot be read: go by what this process remembers, which is nothing at first.
      return this.#memory;
    }
  }

  async #write(jobs) {
    const trimmed = jobs.slice(-this.#limit);
    this.#memory = trimmed;
    if (!this.#file) return;
    // A name of its own, so that another session writing at the same moment does not share the temporary file.
    const temporary = `${this.#file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, jobs: trimmed }, null, 2)}\n`);
      await fs.rename(temporary, this.#file);
    } catch {
      // The job list is a convenience; failing to save it must not fail the tool call.
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** @param {{ id: string, topic: string, createdAt: string }} job */
  add(job) {
    return this.#exclusive(async () => {
      const jobs = (await this.#read()).filter((existing) => existing.id !== job.id);
      jobs.push({ ...job, topic: job.topic.slice(0, 200), projectDir: this.#projectDir, status: 'queued' });
      await this.#write(jobs);
    });
  }

  setStatus(id, status) {
    return this.#exclusive(async () => {
      const jobs = await this.#read();
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job || job.status === status) return;
      job.status = status;
      await this.#write(jobs);
    });
  }

  /** Jobs started from this project, newest first. */
  recent() {
    return this.#exclusive(async () => {
      const jobs = await this.#read();
      return jobs.filter((job) => job.projectDir === this.#projectDir).reverse();
    });
  }
}
