/**
 * Driver interface. v1 ships a tmux driver; a future bun-pty driver can slot in
 * without touching agent().
 */
import type { PaneInfo } from '../types.ts';

export interface SpawnArgs {
  name: string;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
}

export interface Driver {
  readonly name: string;
  spawn(a: SpawnArgs): Promise<void>;
  /** Capture the live pane. scrollback=true includes full history. */
  capture(name: string, o?: { scrollback?: boolean }): Promise<string>;
  /** Send a named key (e.g. 'Enter'). NEVER feed multi-line text here. */
  sendKeys(name: string, keys: string): Promise<void>;
  /** Paste arbitrary (multi-line safe) text via bracketed paste. */
  paste(name: string, text: string): Promise<void>;
  list(prefix?: string): Promise<PaneInfo[]>;
  isAlive(name: string): Promise<boolean>;
  kill(name: string): Promise<void>;
  attach(name: string, o?: { readOnly?: boolean }): Promise<number>;
  attachCommand(name: string, o?: { readOnly?: boolean }): string;
}

import { TmuxDriver } from './tmux.ts';

const drivers: Record<string, () => Driver> = {
  tmux: () => new TmuxDriver(),
};

/** Resolve a Driver by name (default 'tmux'). */
export function getDriver(name = 'tmux'): Driver {
  const make = drivers[name];
  if (!make) {
    throw new Error(`unknown driver '${name}' (available: ${Object.keys(drivers).join(', ')})`);
  }
  return make();
}
