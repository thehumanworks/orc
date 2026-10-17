/**
 * The codex harness's conversation log, in pi's session JSONL format v3 (pi-coding-agent
 * 1.2.0 `docs/session-format.md`), at `~/.orc/sessions/<sid>/codex-session.jsonl`.
 *
 *   line 1   {"type":"session","version":3,"id":<sid>,"timestamp":<iso>,"cwd":<cwd>}
 *   then     {"type":"model_change","id","parentId","timestamp","provider":"openai","modelId"}
 *            {"type":"thinking_level_change",…,"thinkingLevel"}
 *            {"type":"message","id","parentId","timestamp","message":<pi-ai AgentMessage>}…
 *
 * Entry ids are 8 hex chars; each entry's parentId is the previous entry (a linear branch).
 * Every message the agent loop finalises (system, user, assistant, toolResult) is appended
 * as it ends, so a crash loses at most the in-flight assistant message. Resume replays the
 * message entries in order (the leading system message carries the original prompt and
 * tool declarations). `orc read` parses this file with the pi transcript parser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export const CODEX_SESSION_FILE_NAME = 'codex-session.jsonl';
export const SESSION_FORMAT_VERSION = 3;

export interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface LoadedSession {
  header: SessionHeader;
  messages: AgentMessage[];
  /** Latest model (model_change entry, else the last assistant message's model). */
  modelId?: string;
  thinkingLevel?: string;
  lastEntryId: string | null;
  /** Unparseable lines skipped (a torn tail after a crash). */
  skippedLines: number;
}

function entryId(): string {
  return randomBytes(4).toString('hex');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read a session file. Throws when missing or when line 1 is not a v3-compatible header.
 *
 * The conversation is the ACTIVE branch: the entries on the parentId chain from the last
 * entry back to the root (a session continued in pi after `orc takeover` may contain
 * branches). When that chain is broken, every entry is used in file order.
 */
export function loadSession(file: string): LoadedSession {
  const textContent = fs.readFileSync(file, 'utf8');
  const lines = textContent.split('\n');
  let header: SessionHeader | undefined;
  const entries: Array<Record<string, unknown>> = [];
  let skippedLines = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }
    if (!isRecord(v)) {
      skippedLines++;
      continue;
    }
    if (!header) {
      if (v.type !== 'session' || typeof v.id !== 'string' || typeof v.cwd !== 'string') {
        throw new Error(`not a pi session file (bad header): ${file}`);
      }
      header = v as unknown as SessionHeader;
      continue;
    }
    if (typeof v.id === 'string') entries.push(v);
  }
  if (!header) throw new Error(`empty session file: ${file}`);
  const lastEntryId = entries.length > 0 ? (entries[entries.length - 1]!.id as string) : null;
  const path = activeBranch(entries) ?? entries;

  const messages: AgentMessage[] = [];
  let modelId: string | undefined;
  let thinkingLevel: string | undefined;
  for (const v of path) {
    if (v.type === 'message' && isRecord(v.message) && typeof v.message.role === 'string') {
      messages.push(v.message as unknown as AgentMessage);
      const am = v.message as Record<string, unknown>;
      if (am.role === 'assistant' && typeof am.model === 'string') modelId = am.model;
    } else if (v.type === 'model_change' && typeof v.modelId === 'string') {
      modelId = v.modelId;
    } else if (v.type === 'thinking_level_change' && typeof v.thinkingLevel === 'string') {
      thinkingLevel = v.thinkingLevel;
    }
  }
  return { header, messages, modelId, thinkingLevel, lastEntryId, skippedLines };
}

/** Root → leaf entries of the branch ending at the last entry; undefined when the chain breaks. */
function activeBranch(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
  if (entries.length === 0) return [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of entries) byId.set(e.id as string, e);
  const out: Array<Record<string, unknown>> = [];
  let cur: Record<string, unknown> | undefined = entries[entries.length - 1];
  const seen = new Set<string>();
  while (cur) {
    const id = cur.id as string;
    if (seen.has(id)) return undefined; // cycle
    seen.add(id);
    out.push(cur);
    const parent = cur.parentId;
    if (parent === null || parent === undefined) break;
    if (typeof parent !== 'string') return undefined;
    cur = byId.get(parent);
    if (!cur) return undefined; // broken chain
  }
  return out.reverse();
}

/** Append-only writer for one session file. */
export class SessionFileWriter {
  private fd: number;
  private parentId: string | null;

  private constructor(
    readonly file: string,
    fd: number,
    parentId: string | null,
  ) {
    this.fd = fd;
    this.parentId = parentId;
  }

  /** Start a new session file (truncating any previous content) with its header. */
  static create(file: string, header: { id: string; cwd: string }): SessionFileWriter {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'w', 0o600);
    fs.fchmodSync(fd, 0o600);
    const w = new SessionFileWriter(file, fd, null);
    const h: SessionHeader = {
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: header.id,
      timestamp: new Date().toISOString(),
      cwd: header.cwd,
    };
    w.writeLine(h);
    return w;
  }

  /** Continue an existing file after its last entry. A torn last line is cut off first. */
  static append(file: string, lastEntryId: string | null): SessionFileWriter {
    const content = fs.readFileSync(file, 'utf8');
    if (content.length > 0 && !content.endsWith('\n')) {
      // Drop a partial last line (crash mid-write) so the next entry starts on its own line.
      fs.truncateSync(file, Buffer.byteLength(content.slice(0, content.lastIndexOf('\n') + 1), 'utf8'));
    }
    const fd = fs.openSync(file, 'a', 0o600);
    return new SessionFileWriter(file, fd, lastEntryId);
  }

  private writeLine(obj: unknown): void {
    fs.writeSync(this.fd, `${JSON.stringify(obj)}\n`);
  }

  private entry(type: string, fields: Record<string, unknown>): void {
    const id = entryId();
    this.writeLine({ type, id, parentId: this.parentId, timestamp: new Date().toISOString(), ...fields });
    this.parentId = id;
  }

  appendMessage(message: AgentMessage): void {
    this.entry('message', { message });
  }

  appendModelChange(modelId: string, provider = 'openai'): void {
    this.entry('model_change', { provider, modelId });
  }

  appendThinkingLevel(level: string): void {
    this.entry('thinking_level_change', { thinkingLevel: level });
  }

  sync(): void {
    try {
      fs.fsyncSync(this.fd);
    } catch {
      // best effort
    }
  }

  close(): void {
    try {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}
