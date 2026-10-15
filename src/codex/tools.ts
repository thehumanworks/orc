/**
 * The codex harness's minimal coding toolset: read, write, edit, bash, ls.
 *
 * Names and parameter schemas match pi 1.2.0's built-in tools (`core/tools/{read,write,
 * edit,bash,ls}.js`, MIT) so a harness transcript is a well-formed pi session and the same
 * model prompts work against both. The implementations are orc's own and deliberately
 * small: text only (no image attachments), no syntax highlighting, no diff rendering.
 *
 * Paths resolve against the session cwd (`~` → $HOME). There is no sandbox: like every orc
 * provider the harness runs yolo, with the user's permissions.
 *
 * bash runs `bash -c` (else `sh -c`) in the harness's OWN process group (never detached),
 * so killing the provider group kills every command. An aborted or timed-out command has
 * its whole process tree killed (SIGTERM, then SIGKILL).
 *
 * Output limits follow pi: 2000 lines or 50 KB, whichever comes first (read keeps the
 * head, bash keeps the tail and saves the full output to a temp file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
const LS_DEFAULT_LIMIT = 500;
/** pi caps a bash timeout at one day. */
const MAX_TIMEOUT_SECONDS = 86_400;

export interface ToolHost {
  cwd: string;
  /** Environment for bash commands (the harness env). */
  env: Record<string, string | undefined>;
}

type TextResult = AgentToolResult<Record<string, unknown> | undefined>;

function text(t: string, details?: Record<string, unknown>, isError = false): TextResult {
  return { content: [{ type: 'text', text: t }], details, ...(isError ? { isError: true } : {}) };
}

/** Resolve a tool path against the session cwd (`~` and `~/x` expand to $HOME). */
export function resolveToolPath(p: string, host: ToolHost): string {
  const home = host.env.HOME && host.env.HOME.length > 0 ? host.env.HOME : os.homedir();
  let s = p.trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return path.resolve(host.cwd, s);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

export interface Truncation {
  content: string;
  truncated: boolean;
  by: 'lines' | 'bytes' | null;
  totalLines: number;
  outputLines: number;
  firstLineTooLong: boolean;
}

/** Keep the first lines within MAX_LINES / MAX_BYTES (never a partial line). */
export function truncateHead(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncation {
  const lines = splitLines(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { content, truncated: false, by: null, totalLines, outputLines: totalLines, firstLineTooLong: false };
  }
  if (lines.length > 0 && Buffer.byteLength(lines[0]!, 'utf8') > maxBytes) {
    return { content: '', truncated: true, by: 'bytes', totalLines, outputLines: 0, firstLineTooLong: true };
  }
  const out: string[] = [];
  let bytes = 0;
  let by: 'lines' | 'bytes' = 'lines';
  for (const line of lines) {
    if (out.length >= maxLines) {
      by = 'lines';
      break;
    }
    const b = Buffer.byteLength(line, 'utf8') + (out.length > 0 ? 1 : 0);
    if (bytes + b > maxBytes) {
      by = 'bytes';
      break;
    }
    out.push(line);
    bytes += b;
  }
  return { content: out.join('\n'), truncated: true, by, totalLines, outputLines: out.length, firstLineTooLong: false };
}

/** Keep the last lines within MAX_LINES / MAX_BYTES (a single huge last line is cut). */
export function truncateTail(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncation {
  const lines = splitLines(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { content, truncated: false, by: null, totalLines, outputLines: totalLines, firstLineTooLong: false };
  }
  const out: string[] = [];
  let bytes = 0;
  let by: 'lines' | 'bytes' = 'lines';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length >= maxLines) {
      by = 'lines';
      break;
    }
    const line = lines[i]!;
    const b = Buffer.byteLength(line, 'utf8') + (out.length > 0 ? 1 : 0);
    if (bytes + b > maxBytes) {
      by = 'bytes';
      if (out.length === 0) {
        // One enormous last line: keep its tail.
        const buf = Buffer.from(line, 'utf8');
        out.unshift(buf.subarray(buf.length - maxBytes).toString('utf8'));
      }
      break;
    }
    out.unshift(line);
    bytes += b;
  }
  return { content: out.join('\n'), truncated: true, by, totalLines, outputLines: out.length, firstLineTooLong: false };
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8_192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------------
// Per-file mutation queue (write/edit on the same path never interleave)
// ---------------------------------------------------------------------------------

const fileQueues = new Map<string, Promise<unknown>>();

async function withFileQueue<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(file) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  fileQueues.set(file, run);
  try {
    return await run;
  } finally {
    if (fileQueues.get(file) === run) fileQueues.delete(file);
  }
}

// ---------------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------------

const readSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
  offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});

function readTool(host: ToolHost): AgentTool<typeof readSchema> {
  return {
    name: 'read',
    label: 'read',
    description:
      `Read the contents of a text file. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB ` +
      '(whichever is hit first). Use offset/limit for large files. When you need the full file, continue with ' +
      'offset until complete.',
    parameters: readSchema,
    async execute(_id, { path: p, offset, limit }, signal) {
      signal?.throwIfAborted();
      const abs = resolveToolPath(p, host);
      const buf = await fs.promises.readFile(abs);
      if (isBinary(buf)) return text(`[binary file ${p}: ${formatSize(buf.length)}; not shown]`);
      const all = buf.toString('utf8').split('\n');
      const start = offset ? Math.max(0, Math.floor(offset) - 1) : 0;
      if (start >= all.length) throw new Error(`Offset ${offset} is beyond end of file (${all.length} lines total)`);
      const end = limit !== undefined ? Math.min(start + Math.max(0, Math.floor(limit)), all.length) : all.length;
      const selected = all.slice(start, end).join('\n');
      const t = truncateHead(selected);
      const first = start + 1;
      if (t.firstLineTooLong) {
        return text(
          `[Line ${first} exceeds the ${formatSize(MAX_BYTES)} limit. Use bash: sed -n '${first}p' ${p} | head -c ${MAX_BYTES}]`,
        );
      }
      if (t.truncated) {
        const last = first + t.outputLines - 1;
        const limitNote = t.by === 'bytes' ? ` (${formatSize(MAX_BYTES)} limit)` : '';
        return text(`${t.content}\n\n[Showing lines ${first}-${last} of ${all.length}${limitNote}. Use offset=${last + 1} to continue.]`);
      }
      if (limit !== undefined && end < all.length) {
        return text(`${t.content}\n\n[${all.length - end} more lines in file. Use offset=${end + 1} to continue.]`);
      }
      return text(t.content);
    },
  };
}

// ---------------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------------

const writeSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
  content: Type.String({ description: 'Content to write to the file' }),
});

function writeTool(host: ToolHost): AgentTool<typeof writeSchema> {
  return {
    name: 'write',
    label: 'write',
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    async execute(_id, { path: p, content }, signal) {
      signal?.throwIfAborted();
      const abs = resolveToolPath(p, host);
      return withFileQueue(abs, async () => {
        signal?.throwIfAborted();
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, content, 'utf8');
        return text(`Successfully wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${p}`);
      });
    },
  };
}

// ---------------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------------

const editSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description:
          'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
      }),
      newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
    }),
    {
      description:
        'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
    },
  ),
});

interface EditSpec {
  oldText: string;
  newText: string;
}

/** Accept pi's legacy single-edit shape `{path, oldText, newText}` too. */
function prepareEditArguments(args: unknown): { path: string; edits: EditSpec[] } {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  let edits = a.edits;
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      // left as-is: schema validation reports it
    }
  }
  if (edits && !Array.isArray(edits) && typeof edits === 'object') edits = [edits];
  const list = Array.isArray(edits) ? [...(edits as EditSpec[])] : [];
  if (typeof a.oldText === 'string' && typeof a.newText === 'string') list.push({ oldText: a.oldText, newText: a.newText });
  return { path: a.path as string, edits: list };
}

/** Apply exact, unique, non-overlapping replacements to LF-normalized content. */
export function applyEdits(content: string, edits: EditSpec[], label: string): string {
  if (edits.length === 0) throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
  const spans: Array<{ start: number; end: number; newText: string }> = [];
  edits.forEach((e, i) => {
    const oldText = e.oldText.replace(/\r\n/g, '\n');
    const newText = e.newText.replace(/\r\n/g, '\n');
    if (oldText.length === 0) throw new Error(`edits[${i}].oldText must not be empty.`);
    const first = content.indexOf(oldText);
    if (first === -1) {
      throw new Error(
        `Could not find edits[${i}].oldText in ${label}. The text must match exactly, including whitespace and indentation.`,
      );
    }
    const again = content.indexOf(oldText, first + 1);
    if (again !== -1) {
      let n = 0;
      for (let at = content.indexOf(oldText); at !== -1; at = content.indexOf(oldText, at + 1)) n++;
      throw new Error(`Found ${n} occurrences of edits[${i}].oldText in ${label}. Add surrounding context to make it unique.`);
    }
    spans.push({ start: first, end: first + oldText.length, newText });
  });
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) throw new Error(`edits overlap in ${label}; merge them into one edit.`);
  }
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += content.slice(at, s.start) + s.newText;
    at = s.end;
  }
  return out + content.slice(at);
}

function editTool(host: ToolHost): AgentTool<typeof editSchema> {
  return {
    name: 'edit',
    label: 'edit',
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    async execute(_id, { path: p, edits }, signal) {
      signal?.throwIfAborted();
      const abs = resolveToolPath(p, host);
      return withFileQueue(abs, async () => {
        let raw: string;
        try {
          raw = await fs.promises.readFile(abs, 'utf8');
        } catch (e) {
          throw new Error(`Could not edit file: ${p}. Error code: ${(e as { code?: string }).code ?? String(e)}.`);
        }
        signal?.throwIfAborted();
        const bom = raw.startsWith('﻿') ? '﻿' : '';
        const body = bom ? raw.slice(1) : raw;
        const crlf = body.includes('\r\n');
        const normalized = crlf ? body.replace(/\r\n/g, '\n') : body;
        const next = applyEdits(normalized, edits, p);
        const final = bom + (crlf ? next.replace(/\n/g, '\r\n') : next);
        await fs.promises.writeFile(abs, final, 'utf8');
        return text(`Successfully replaced ${edits.length} block(s) in ${p}.`);
      });
    },
  };
}

// ---------------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------------

const bashSchema = Type.Object({
  command: Type.String({ description: 'Shell command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
});

function shellPath(): string {
  for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
    if (fs.existsSync(p)) return p;
  }
  return '/bin/sh';
}

/** Every descendant of `pid` (children first-level up to leaves), via one `ps` call. */
export function descendantPids(pid: number): number[] {
  let out = '';
  try {
    out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString();
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const c = Number(m[1]);
    const parent = Number(m[2]);
    const list = children.get(parent);
    if (list) list.push(c);
    else children.set(parent, [c]);
  }
  const found: number[] = [];
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (found.includes(p)) continue;
    found.push(p);
    stack.push(...(children.get(p) ?? []));
  }
  return found;
}

/** Kill `pid` and its whole tree: SIGTERM, then SIGKILL after `graceMs`. */
export async function killTree(pid: number, graceMs = 1_000): Promise<void> {
  const signalAll = (sig: NodeJS.Signals) => {
    for (const p of [pid, ...descendantPids(pid)]) {
      try {
        process.kill(p, sig);
      } catch {
        // gone
      }
    }
  };
  const tree = [pid, ...descendantPids(pid)];
  signalAll('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && tree.some(alive)) await Bun.sleep(25);
  for (const p of [...tree, ...descendantPids(pid)]) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live bash children of this harness (killed on shutdown). */
const runningCommands = new Set<number>();

/** Kill every bash command still running (harness shutdown). */
export async function killRunningCommands(graceMs = 500): Promise<void> {
  await Promise.all([...runningCommands].map((pid) => killTree(pid, graceMs)));
}

function bashTool(host: ToolHost): AgentTool<typeof bashSchema> {
  return {
    name: 'bash',
    label: 'bash',
    description:
      `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${MAX_LINES} lines ` +
      `or ${MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    async execute(_id, { command, timeout }, signal) {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
        throw new Error('Invalid timeout: must be a positive number of seconds');
      }
      if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) {
        throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
      }
      signal?.throwIfAborted();
      if (!fs.existsSync(host.cwd)) throw new Error(`Working directory does not exist: ${host.cwd}`);
      const started = performance.now();
      const proc = Bun.spawn([shellPath(), '-c', command], {
        cwd: host.cwd,
        env: host.env as Record<string, string>,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      runningCommands.add(proc.pid);
      const chunks: string[] = [];
      const readers: Array<{ cancel(): Promise<void> }> = [];
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        readers.push(reader);
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(dec.decode(value, { stream: true }));
          }
        } catch {
          // cancelled (background writers outlived the shell) or stream error
        }
        const rest = dec.decode();
        if (rest) chunks.push(rest);
      };
      let stopped: 'aborted' | 'timeout' | null = null;
      const stop = (why: 'aborted' | 'timeout') => {
        if (stopped) return;
        stopped = why;
        void killTree(proc.pid);
      };
      const onAbort = () => stop('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = timeout !== undefined ? setTimeout(() => stop('timeout'), timeout * 1_000) : undefined;
      let exitCode: number | null;
      let detachedWriters = false;
      try {
        const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
        exitCode = await proc.exited;
        // A background job (`cmd &`) can keep the pipes open after the shell exited: stop
        // reading shortly after the exit instead of waiting for it.
        const drained = await Promise.race([pumps.then(() => true), Bun.sleep(300).then(() => false)]);
        if (!drained) {
          detachedWriters = true;
          for (const r of readers) r.cancel().catch(() => {});
          await pumps;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        runningCommands.delete(proc.pid);
      }
      const full = chunks.join('') + (detachedWriters ? '\n[background processes still hold the output; not waited for]' : '');
      const t = truncateTail(full);
      let outText = t.content;
      if (t.truncated) {
        const file = path.join(os.tmpdir(), `orc-bash-${randomBytes(6).toString('hex')}.log`);
        try {
          fs.writeFileSync(file, full, { mode: 0o600 });
        } catch {
          // best effort
        }
        const first = t.totalLines - t.outputLines + 1;
        outText += `\n\n[Showing lines ${first}-${t.totalLines} of ${t.totalLines}${t.by === 'bytes' ? ` (${formatSize(MAX_BYTES)} limit)` : ''}. Full output: ${file}]`;
      }
      const withStatus = (status: string) => `${outText ? `${outText}\n\n` : ''}${status}`;
      if (stopped === 'aborted') throw new Error(withStatus('Command aborted'));
      if (stopped === 'timeout') throw new Error(withStatus(`Command timed out after ${timeout} seconds`));
      const wall = Math.round((performance.now() - started) / 100) / 10;
      const details = { exit_code: exitCode, wall_time_seconds: wall, truncated: t.truncated };
      if (exitCode === null || proc.signalCode) {
        throw new Error(withStatus(`Command terminated by ${proc.signalCode ?? 'unknown signal'}`));
      }
      if (exitCode !== 0) return text(withStatus(`Command exited with code ${exitCode}`), details, true);
      return text(outText.length > 0 ? outText : '(no output)', details);
    },
  };
}

// ---------------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------------

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory to list (default: current directory)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of entries to return (default: 500)' })),
});

function lsTool(host: ToolHost): AgentTool<typeof lsSchema> {
  return {
    name: 'ls',
    label: 'ls',
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries or ${MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsSchema,
    async execute(_id, { path: p, limit }, signal) {
      signal?.throwIfAborted();
      const abs = resolveToolPath(p ?? '.', host);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      const names = entries
        .map((e) => {
          let dir = e.isDirectory();
          if (e.isSymbolicLink()) {
            try {
              dir = fs.statSync(path.join(abs, e.name)).isDirectory();
            } catch {
              dir = false;
            }
          }
          return dir ? `${e.name}/` : e.name;
        })
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const max = limit !== undefined && limit > 0 ? Math.floor(limit) : LS_DEFAULT_LIMIT;
      const shown = names.slice(0, max);
      const t = truncateHead(shown.join('\n'));
      let out = t.content.length > 0 ? t.content : '(empty directory)';
      if (names.length > shown.length || t.truncated) {
        out += `\n\n[Showing ${t.outputLines} of ${names.length} entries. Use limit to see more.]`;
      }
      return text(out);
    },
  };
}

/** The harness toolset, bound to one session cwd. */
export function createCodingTools(host: ToolHost): AgentTool<any>[] {
  return [readTool(host), bashTool(host), editTool(host), writeTool(host), lsTool(host)];
}

/** Tool names, in declaration order (ready.info, docs). */
export const CODING_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'ls'] as const;
