// File access for tools that attach files to a request or save a result.
//
// An MCP server runs with the user's full permissions and its file access does
// not pass through Claude Code's own Read/Write permission checks. Everything
// a tool reads is sent to an external API, so access is deliberately narrow:
//
//   * only inside the project directory (plus PLAMO_ALLOWED_DIRS), after
//     resolving symlinks;
//   * never files that look like credentials;
//   * writes never replace a file unless asked to, and never land in hidden
//     directories such as .git or .claude.

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { ToolError } from './errors.mjs';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Upper bound for everything attached to one request; the API has the final say on what fits. */
export const MAX_ATTACHMENT_CHARS = 1_000_000;

export class FileAccessError extends ToolError {
  constructor(message) {
    super(message);
    this.name = 'FileAccessError';
  }
}

const SECRET_KEY_FILES =
  /^(id_(rsa|dsa|ecdsa|ed25519)(?!.*\.pub$).*|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.?htpasswd|\.envrc|\.dev\.vars|\.mcp\.json|token\.json|auth\.json|\.pgpass|\.my\.cnf|\.vault-token|kubeconfig(\.ya?ml)?|wallet\.dat|\.[a-z_]+_history)$/i;
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|kdbx|tfvars|tfstate)$/i;
// ".env", ".env.local", ".env-production", "prod.env" ...
const ENV_FILE = /^\.env([._-].*)?$|\.env$/i;
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/i;
// A copy of a secret is still a secret: "secrets.yaml.bak", "server.key.old", "terraform.tfstate.backup".
const BACKUP_SUFFIX = /(\.(bak|old|orig|backup|save|swp|tmp)|~)$/i;
// "credentials.json", "my-api-key.txt", "secrets.yaml" ... but not source files
// such as "credentials_provider.ts": the name rule only applies to data files.
const SECRET_WORD = /(^|[._-])(secrets?|credentials?|passwords?|passwd|apikeys?|api[_-]keys?|private[_-]?keys?|access[_-]?tokens?|keystores?)([._-]|$)|service[._-]?account/i;
const DATA_EXTENSIONS = new Set(['', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.csv', '.xml']);
const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.git', 'secrets', '.secrets', 'credentials', '.credentials']);

/**
 * Whether a path looks like it holds credentials and must not leave the
 * machine. This goes by names only, so it is a safety net and not a guarantee.
 */
export function looksSensitive(filePath) {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  if (segments.slice(0, -1).some((segment) => SECRET_DIRECTORIES.has(segment.toLowerCase()))) return true;
  let base = segments[segments.length - 1] ?? '';
  while (BACKUP_SUFFIX.test(base)) base = base.replace(BACKUP_SUFFIX, '');
  if (ENV_FILE.test(base) && !ENV_TEMPLATE.test(base)) return true;
  if (SECRET_KEY_FILES.test(base) || SECRET_EXTENSIONS.test(base)) return true;
  // ".tfvars.json" and the like: the extension that matters is not always the last one.
  if (/\.(tfvars|tfstate)\.[a-z0-9]+$/i.test(base)) return true;
  if (SECRET_WORD.test(base) && DATA_EXTENSIONS.has(path.extname(base).toLowerCase())) return true;
  return false;
}

/** Whether `relative` (from path.relative) climbs out of its base directory. */
function escapes(relative) {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isInside(child, root) {
  return !escapes(path.relative(root, child));
}

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function decodeText(buffer, displayPath) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new FileAccessError(`${displayPath} looks like a binary file; only text files can be used.`);
  }
  const body = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new FileAccessError(`${displayPath} is not valid UTF-8 text. Convert it to UTF-8 first.`);
  }
}

/**
 * @param {{ projectDir: string, allowedDirs: string[] }} options
 */
export function createFileAccess({ projectDir, allowedDirs }) {
  let realRootsPromise = null;

  /** Allowed roots with symlinks resolved (for example /tmp is /private/tmp on macOS). */
  function realRoots() {
    realRootsPromise ??= Promise.all(
      allowedDirs.map(async (dir) => {
        try {
          return await fs.realpath(dir);
        } catch {
          return path.resolve(dir);
        }
      }),
    );
    return realRootsPromise;
  }

  function display(absolutePath) {
    const relative = path.relative(projectDir, absolutePath);
    return relative && !escapes(relative) ? relative : absolutePath;
  }

  function outsideError(inputPath) {
    return new FileAccessError(
      `${inputPath} is outside the project directory (${projectDir}). This server only accesses files inside the project. ` +
        'Start Claude Code in the directory that contains the file, add the directory to PLAMO_ALLOWED_DIRS, or pass the text itself instead of a path.',
    );
  }

  /** Resolve a path that may not exist yet by resolving its nearest existing ancestor. */
  async function realpathAllowMissing(absolutePath) {
    const missing = [];
    let current = absolutePath;
    for (;;) {
      try {
        const real = await fs.realpath(current);
        return path.join(real, ...missing.reverse());
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        const parent = path.dirname(current);
        if (parent === current) return absolutePath;
        missing.push(path.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Read a text file that will be sent to the API.
   * @param {string} inputPath  Absolute, or relative to the project directory.
   * @returns {Promise<{ path: string, absolutePath: string, text: string }>}
   */
  async function readText(inputPath) {
    const absolute = path.resolve(projectDir, expandHome(inputPath));
    let real;
    try {
      real = await fs.realpath(absolute);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw new FileAccessError(`File not found: ${inputPath} (resolved to ${absolute}). Use an absolute path or a path relative to the project root.`);
      }
      throw new FileAccessError(`Cannot access ${inputPath}: ${error.message}`);
    }

    const roots = await realRoots();
    const root = roots.find((candidate) => isInside(real, candidate));
    if (!root) throw outsideError(inputPath);

    const shown = display(real);
    // Judged by the names inside the allowed directory, both as given and as
    // resolved: a link called ".env" is refused, and so is a link to one. The
    // directories above the project say nothing about the file.
    const given = path.relative(projectDir, absolute);
    if (looksSensitive(path.relative(root, real)) || looksSensitive(escapes(given) ? path.basename(absolute) : given)) {
      throw new FileAccessError(
        `${shown} looks like it contains credentials, so it was not sent to the PLaMo API. ` +
          'If the content is safe to share, pass the relevant text directly instead of the file path.',
      );
    }

    let stat;
    try {
      stat = await fs.stat(real);
    } catch (error) {
      throw new FileAccessError(`Cannot access ${shown}: ${error.message}`);
    }
    if (stat.isDirectory()) throw new FileAccessError(`${shown} is a directory; pass individual files.`);
    if (!stat.isFile()) throw new FileAccessError(`${shown} is not a regular file.`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new FileAccessError(`${shown} is too large (${stat.size} bytes; the limit is ${MAX_FILE_BYTES} bytes per file). Split it or pass an excerpt.`);
    }

    const buffer = await fs.readFile(real);
    return { path: shown, absolutePath: real, text: decodeText(buffer, shown) };
  }

  /**
   * Read several attachments, skipping repeated paths.
   * @param {string[] | undefined} inputPaths
   * @returns {Promise<{ path: string, absolutePath: string, text: string }[]>}
   */
  async function readAll(inputPaths) {
    const attachments = [];
    let totalChars = 0;
    for (const inputPath of inputPaths ?? []) {
      const file = await readText(inputPath);
      if (attachments.some((existing) => existing.absolutePath === file.absolutePath)) continue;
      totalChars += file.text.length;
      if (totalChars > MAX_ATTACHMENT_CHARS) {
        throw new FileAccessError(
          `The attached files are too large together (more than ${MAX_ATTACHMENT_CHARS} characters). Attach fewer files or pass excerpts.`,
        );
      }
      attachments.push(file);
    }
    return attachments;
  }

  /**
   * Check where a result may be written, without writing anything.
   * @returns {Promise<{ path: string, absolutePath: string, exists: boolean }>}
   */
  async function resolveWritable(inputPath, { overwrite = false } = {}) {
    const absolute = path.resolve(projectDir, expandHome(inputPath));
    let real;
    try {
      real = await realpathAllowMissing(absolute);
    } catch (error) {
      throw new FileAccessError(`Cannot use ${inputPath} as an output path: ${error.message}`);
    }
    const roots = await realRoots();
    const root = roots.find((candidate) => isInside(real, candidate));
    if (!root) throw outsideError(inputPath);

    const shown = display(real);
    const hidden = path.relative(root, real).split(path.sep).find((segment) => segment.startsWith('.'));
    if (hidden) {
      throw new FileAccessError(
        `Refusing to write ${shown}: output files cannot be hidden files or live in hidden directories (found "${hidden}"). Choose another path.`,
      );
    }

    let exists = false;
    try {
      const stat = await fs.stat(real);
      if (stat.isDirectory()) throw new FileAccessError(`${shown} is a directory; give a file path.`);
      exists = true;
    } catch (error) {
      if (error instanceof FileAccessError) throw error;
      if (error.code !== 'ENOENT') throw new FileAccessError(`Cannot access ${shown}: ${error.message}`);
    }
    if (exists && !overwrite) {
      throw new FileAccessError(`${shown} already exists. Choose another path, or pass overwrite: true to replace it.`);
    }

    // Find out now whether the file can be written, rather than after the
    // work whose result it is meant to hold. A read-only file stays as it is.
    try {
      if (exists) await fs.access(real, fsConstants.W_OK);
      await fs.access(await nearestExistingDirectory(path.dirname(real)), fsConstants.W_OK);
    } catch {
      throw new FileAccessError(`${shown} cannot be written: ${exists ? 'the file or its directory' : 'the directory'} is read-only. Choose another path.`);
    }
    return { path: shown, absolutePath: real, exists };
  }

  /** The directory itself, or the closest ancestor that exists. */
  async function nearestExistingDirectory(directory) {
    for (let current = directory; ; current = path.dirname(current)) {
      try {
        if ((await fs.stat(current)).isDirectory()) return current;
      } catch {
        // Does not exist yet: it will be created, inside its parent.
      }
      if (path.dirname(current) === current) return current;
    }
  }

  /**
   * Save text produced by the API.
   * @returns {Promise<{ path: string, absolutePath: string, bytes: number, replaced: boolean }>}
   */
  async function writeText(inputPath, text, { overwrite = false } = {}) {
    const target = await resolveWritable(inputPath, { overwrite });
    const data = Buffer.from(text, 'utf8');
    try {
      await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
    } catch (error) {
      throw new FileAccessError(`Could not create the directory for ${target.path}: ${error.message}`);
    }

    if (!overwrite) {
      // "wx" fails if the file appeared since the check above, so nothing is clobbered.
      try {
        await fs.writeFile(target.absolutePath, data, { flag: 'wx' });
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new FileAccessError(`${target.path} already exists. Choose another path, or pass overwrite: true to replace it.`);
        }
        throw new FileAccessError(`Could not write ${target.path}: ${error.message}`);
      }
    } else {
      const temporary = `${target.absolutePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, data, { flag: 'wx' });
        // The replacement keeps the permissions of the file it replaces: a private file stays private.
        if (target.exists) await fs.chmod(temporary, (await fs.stat(target.absolutePath)).mode & 0o7777);
        await fs.rename(temporary, target.absolutePath);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw new FileAccessError(`Could not write ${target.path}: ${error.message}`);
      }
    }
    return { path: target.path, absolutePath: target.absolutePath, bytes: data.length, replaced: target.exists };
  }

  return { readText, readAll, resolveWritable, writeText, display };
}
