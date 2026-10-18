/**
 * Golden tests for the human renderers.
 *
 * test/fixtures/render-golden.json holds the output of the renderers on main @ 1d7cbda
 * (before styling existed) over test/fixtures/render-fixtures.ts. Colour off — the default
 * PLAIN style, or a sanitizing (TTY) style on this clean data — must reproduce it byte for
 * byte. Colour on must produce the expected styled text: the same characters plus SGR codes
 * (and status glyphs in place of brackets).
 */
import { describe, expect, test } from 'bun:test';
import goldenJson from './fixtures/render-golden.json';
import * as fx from './fixtures/render-fixtures.ts';
import {
  HELP_TEXT,
  formatError,
  formatWarning,
  renderHelp,
  renderRunDetail,
  renderRunList,
  renderSessionDetail,
  renderSessionLine,
  renderSessionList,
  renderSessionListWithHost,
  renderWorkflowEvent,
  styleWorkflowLine,
} from '../src/cli/output.ts';
import { renderSettingsView } from '../src/settings.ts';
import { renderTurns } from '../src/transcript.ts';
import { renderCapture, renderJournal, renderJournalEntry } from '../src/journal-render.ts';
import { PLAIN, Style, TONE_STYLES, stripAnsi, toneOf } from '../src/style.ts';

type Golden = Record<string, string | (string | null)[]>;
const golden = goldenJson as Golden;
const g = (k: string) => golden[k] as string;
const gl = (k: string) => golden[k] as string[];
const gn = (k: string) => golden[k] as (string | null)[];

const ANSI = new Style({ color: true });
const TTY_PLAIN = new Style({ sanitize: true }); // a terminal with colour off

// SGR helpers for the expected styled text.
const w = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const B = w('1', '22');
const D = w('2', '22');
const R = w('31', '39');
const G = w('32', '39');
const Y = w('33', '39');
const M = w('35', '39');
const C = w('36', '39');
const BC = w('1;36', '22;39');
const BM = w('1;35', '22;39');
const BR = w('1;31', '22;39');
const BY = w('1;33', '22;39');
const DI = w('2;3', '22;23');

/** `<glyph> word` for a status word (what colour mode shows instead of `[word]` / `word`). */
const glyphed = (word: string) => `${TONE_STYLES[toneOf(word)!].glyph} ${word}`;

describe('colour off is byte-identical to the renderers before styling (main @ 1d7cbda)', () => {
  for (const [label, st] of [
    ['default (no style)', undefined],
    ['PLAIN', PLAIN],
    ['a TTY with colour off (sanitizing; clean data)', TTY_PLAIN],
  ] as const) {
    test(label, () => {
      expect(fx.sessionViews.map((v) => renderSessionLine(v, { style: st }))).toEqual(gl('sessionLines'));
      expect(fx.sessionViews.map((v) => renderSessionLine(v, { lineage: true, style: st }))).toEqual(gl('sessionLinesLineage'));
      expect(renderSessionList(fx.sessionViews, { style: st })).toBe(g('sessionList'));
      expect(renderSessionList([], { style: st })).toBe(g('sessionListEmpty'));
      expect(fx.sessionViews.map((v) => renderSessionDetail(v, st))).toEqual(gl('sessionDetails'));
      expect(renderSessionListWithHost(fx.hostViews, st)).toBe(g('hostList'));
      expect(renderSessionListWithHost([], st)).toBe(g('hostListEmpty'));
      expect(fx.workflowEvents.map((e) => renderWorkflowEvent(e, st))).toEqual(gl('workflowEvents'));
      expect(fx.runs.map((r) => renderRunDetail(r, st))).toEqual(gl('runDetails'));
      expect(renderRunList(fx.runs, st)).toBe(g('runList'));
      expect(renderRunList([], st)).toBe(g('runListEmpty'));
      expect(fx.settingsViews.map((v) => renderSettingsView(v, st))).toEqual(gl('settings'));
      expect(renderTurns(fx.turns, st)).toBe(g('turns'));
      expect(renderJournal(fx.journal, st)).toBe(g('journal'));
      expect(fx.journal.map((e) => renderJournalEntry(e, st))).toEqual(gn('journalEntries'));
      expect(renderHelp(st)).toBe(HELP_TEXT);
    });
  }

  test('the SDK-only renderCapture is unchanged', () => {
    expect(renderCapture(fx.journal)).toBe(g('capture'));
  });

  test('HELP_TEXT matches the maintained Pi/Claude reference plus color, version and MCP sections', () => {
    const added = [
      '  --color[=WHEN]        colour: auto (default: only when writing to a terminal) | always | never',
      '  --no-color            same as --color=never. NO_COLOR=1 also disables colour, FORCE_COLOR=1',
      '                        forces it (the flags win); --json output is never coloured',
    ];
    // Added by the `orc --version` change (test/version.test.ts covers it), not by colour.
    const versionLine =
      "  orc --version [--json]                              This binary's version (alias: -V; never remote)";
    // Added by the MCP server (`orc mcp`, the daemon's /mcp; test/mcp-*.test.ts cover it):
    // one usage line and one section (with its trailing blank line), nothing else.
    const mcpUsageLine =
      "  orc mcp    [--wait-timeout SEC]                     Serve orc's commands as MCP tools over stdio (for a lead agent)";
    const mcpSection = [
      "mcp (orc's commands as tools for a lead agent):",
      '  orc mcp               MCP over stdio. Tools: spawn send wait read state list kill resume prune',
      '                        settings guide workflow_run|list|status|logs|resume|retry|cancel|cleanup.',
      '                        Each runs `orc <cmd> … --json` (spawn with --no-wait, workflows with',
      "                        --detach); `host` sends a call to a peer's daemon. The server's",
      '                        instructions and the `guide` tool teach the lead the team method.',
      '                        wait returns within --wait-timeout SEC (default 45): call it again.',
      '  orc daemon            Also serves those tools at http://<bind>:<port>/mcp (Streamable HTTP),',
      "                        always run on the daemon host, behind the daemon's auth. Each tool needs",
      '                        its REST scope: sessions:read (read state list wait settings),',
      '                        sessions:write (spawn send resume), workflows:read|write, admin (kill',
      '                        prune workflow cancel|cleanup). Host and Origin must name the daemon:',
      '                        --mcp-allow-host H (repeatable) adds a name.',
      '',
    ];
    const lines = HELP_TEXT.split('\n');
    const at = lines.indexOf(added[0]!);
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe('  --json                machine-readable output; non-zero exit + {error} on failure');
    expect(lines.slice(at, at + 3)).toEqual(added);
    expect(lines.filter((l) => l === versionLine)).toHaveLength(1);
    expect(lines.filter((l) => l === mcpUsageLine)).toHaveLength(1);
    const rest = [...lines.slice(0, at), ...lines.slice(at + 3)].filter((l) => l !== versionLine && l !== mcpUsageLine);
    const mcpAt = rest.indexOf(mcpSection[0]!);
    expect(mcpAt).toBeGreaterThan(0);
    expect(rest.slice(mcpAt, mcpAt + mcpSection.length)).toEqual(mcpSection);
    rest.splice(mcpAt, mcpSection.length);
    expect(rest.join('\n')).toBe(g('help'));
  });
});

describe('colour on: the expected styled output', () => {
  test('session list rows: id bold, status glyph + colour, state coloured, keys dim, paths dim', () => {
    const [running, suspended, taken] = fx.sessionViews;
    expect(renderSessionLine(running!, { style: ANSI })).toBe(
      `${B('a1b2c3d4')}  claude ${C('● running')} ${G('done')} ${D('model=')}haiku ${D('agent=')}reviewer ` +
        `${D('alias=')}${C('@orc:dbg')}  ${D('cwd=')}${D('/home/u/src/orc/.orc/worktrees/a1b2c3d4')} ` +
        `${D('wt=')}${D('/home/u/src/orc/.orc/worktrees/a1b2c3d4')}`,
    );
    expect(renderSessionLine(suspended!, { style: ANSI })).toBe(
      `${B('e5f6a7b8')}  codex ${M('◌ suspended')} ${R('failed')} ${D('model=')}gpt-5-codex  ${D('cwd=')}${D('/home/u/src/orc')}` +
        ` ${D('root=')}${D('r00t0001')} ${D('run=')}${D('run00002')} ${D('step=')}${D('build')} ${D('depth=')}${D('1')}`,
    );
    expect(renderSessionLine(taken!, { style: ANSI })).toBe(
      `${B('c9d0e1f2')}  pi ${D('○ dead')} ${R('failed')} ${Y('taken-over(hand back: orc resume c9d0e1f2)')}  ${D('cwd=')}${D('/tmp/scratch')}`,
    );
    expect(renderSessionList([], { style: ANSI })).toBe(D('(no sessions)'));
  });

  test('every session row = the plain row with its [status] shown as a glyph', () => {
    fx.sessionViews.forEach((v, i) => {
      const expected = gl('sessionLines')[i]!.replace(/\[(\w+)\]/, (_m, s: string) => glyphed(s));
      expect(stripAnsi(renderSessionLine(v, { style: ANSI }))).toBe(expected);
    });
    // The fleet view pads the host before styling it: the columns line up exactly as in plain.
    const plainRows = g('hostList').split('\n');
    stripAnsi(renderSessionListWithHost(fx.hostViews, ANSI))
      .split('\n')
      .forEach((row, i) => expect(row.slice(0, 15)).toBe(plainRows[i]!.slice(0, 15)));
  });

  test('session detail: labels dim, values plain/emphasised, statuses with glyphs', () => {
    const lines = renderSessionDetail(fx.sessionViews[0]!, ANSI).split('\n');
    expect(lines[0]).toBe(`${D('id:')}          ${B('a1b2c3d4')}`);
    expect(lines[5]).toBe(`${D('alias:')}       ${C('@dbg')}`);
    expect(lines[7]).toBe(`${D('status:')}      ${C('● running')}`);
    expect(lines[8]).toBe(`${D('state:')}       ${G('✓ done')}`);
    expect(lines.at(-1)).toBe(`${D('attach:')}      ${C('orc attach a1b2c3d4')}`);
    fx.sessionViews.forEach((v, i) => {
      const expected = gl('sessionDetails')[i]!.replace(/^(status|state):( +)(\w+)$/gm, (_m, k: string, sp: string, s: string) => `${k}:${sp}${glyphed(s)}`);
      expect(stripAnsi(renderSessionDetail(v, ANSI))).toBe(expected);
    });
  });

  test('workflow events: markers coloured by outcome, ids bold, bookkeeping dim (every fixture event)', () => {
    // One literal expectation per fixture event: every event type and variant is pinned.
    const expected: string[] = [
      `${BC('>')} ${B('run')} ${B('run00002')} 'ship-it' ${D('(4 steps)')}\n`,
      `${BC('>')} ${B('run')} ${B('run00003')} 'it's tiny' ${D('(1 step)')}\n`,
      `${D('  · schedule plan (slots left 1)')}\n`,
      `${D('  · schedule build')}\n`,
      `  ${C('●')} ${B('plan')} ${D('[claude]')} ${C('running...')}\n`,
      `${D('  · attempt att-1 plan → dispatched session=a1b2c3d4')}\n`,
      `${D('  · attempt att-1 plan → queued')}\n`,
      `${D('  · lease expires 2026-10-17T09:41:12.345Z')}\n`,
      `  ${G('✓ ok')} ${B('plan')} ${D('(claude)')} ${D('state=')}${G('done')} ${D('commitsAhead=')}0  ${D('session=a1b2c3d4')}\n`,
      `  ${R('✗ FAIL')} ${B('build')} ${D('(codex)')} ${D('state=')}${R('failed')} ${D('commitsAhead=')}0  ${D('session=e5f6a7b8')}` +
        ` ${D('worktree=/home/u/src/orc/.orc/worktrees/e5f6a7b8')}\n`,
      `  ${R('✗ FAIL')} ${B('review')} ${D('(pi)')} ${D('state=')}${G('done')} ${D('commitsAhead=')}2 ${BY('UNVERIFIED')}  ${D('session=')}\n`,
      `  ${Y('! warning:')} no done predicate; reported unverified\n`,
      `  ${R('!')} ${B('build')} ${R('error:')} provider exited (code=1)\nstderr: boom\n`,
      `  ${Y('· blocked')} ${B('merge')}: dependency build failed\n`,
      `${D('  · adopt review session=c9d0e1f2')}\n`,
      `${B('= run')} ${B('run00002')} ${R('✗ failed')}\n`,
      `${B('= run')} ${B('run00005')} ${G('✓ done')}\n`,
      `${B('= run')} ${B('legacy99')} ${M('◌ orphaned')}\n`,
      `${BC('>')} ${B('resume')} ${B('run00002')} ${D('(from ')}${M('orphaned')}${D(')')}\n`,
      `${BC('>')} ${B('retry')} ${B('run00002')} ${D('step')} ${B('build')}\n`,
      `${BC('>')} ${B('retry')} ${B('run00002')}\n`,
      `${B('=')} ${D('cancel')} ${B('run00002')}${D(' (cascade)')}\n`,
      `${B('=')} ${D('cancel')} ${B('run00003')}\n`,
    ];
    expect(expected).toHaveLength(fx.workflowEvents.length);
    fx.workflowEvents.forEach((e, i) => expect(renderWorkflowEvent(e, ANSI)).toBe(expected[i]!));
  });

  test('every workflow event = its plain line with only the same-width glyph markers changed', () => {
    fx.workflowEvents.forEach((e, i) => {
      const expected = gl('workflowEvents')[i]!
        .replace(/^ {2}\[ok\] /, '  ✓ ok ')
        .replace(/^ {2}\[FAIL\] /, '  ✗ FAIL ')
        .replace(/^ {2}- /, '  ● ')
        .replace(/^= run (\S+) (\S+)\n$/, (_m, id: string, s: string) => `= run ${id} ${glyphed(s)}\n`);
      expect(stripAnsi(renderWorkflowEvent(e, ANSI))).toBe(expected);
    });
  });

  test('runner-log lines: `#` notes dim, unrecognised lines untouched, PLAIN is the identity', () => {
    expect(styleWorkflowLine('# orc runner pid=1 action=run run=r at t', ANSI)).toBe(D('# orc runner pid=1 action=run run=r at t'));
    expect(styleWorkflowLine('# orc runner pid=1 terminated (SIGTERM); run r failed', ANSI)).toBe(
      D('# orc runner pid=1 terminated (SIGTERM); run r failed'),
    );
    expect(styleWorkflowLine('error: Cannot find module "x"', ANSI)).toBe('error: Cannot find module "x"');
    expect(styleWorkflowLine('', ANSI)).toBe('');
    expect(styleWorkflowLine('  [ok] plan', PLAIN)).toBe('  [ok] plan');
    // A line that only resembles a step result (missing fields) is not restyled.
    expect(styleWorkflowLine('  [ok] plan (claude)', ANSI)).toBe('  [ok] plan (claude)');
  });

  test('run detail and run list', () => {
    const detail = renderRunDetail(fx.fullRun, ANSI).split('\n');
    expect(detail[0]).toBe(`${D('id:')}         ${B('run00002')}`);
    expect(detail[2]).toBe(`${D('status:')}     ${R('✗ failed')}`);
    expect(detail).toContain(`${B('scheduling:')}`);
    expect(detail).toContain(
      `  ${D('sched')} ${B('merge')} ${Y('! blocked')} ${D('needs=')}${D('[build,review]')} ${D('—')} blocked: required dependency 'build' did not succeed`,
    );
    expect(detail).toContain(`  ${D('attempt')} 1 ${B('plan')} ${G('✓ succeeded')} ${D('session=')}${D('a1b2c3d4')}`);
    expect(detail).toContain(
      `  ${D('attempt')} 1 ${B('build')} ${R('✗ failed')} ${D('session=')}${D('e5f6a7b8')} ${D('err=')}${R('verify failed: 0 commits ahead of main')}`,
    );
    fx.runs.forEach((r, i) => {
      const expected = gl('runDetails')[i]!
        .replace(/^status:( +)(\w+)$/m, (_m, sp: string, s: string) => `status:${sp}${glyphed(s)}`)
        .replace(/^ {2}\[ok\] /gm, '  ✓ ok ')
        .replace(/^ {2}\[FAIL\] /gm, '  ✗ FAIL ')
        .replace(/^( {2}(?:sched \S+|attempt \d+ \S+)) \[(\S+)\]/gm, (_m, head: string, s: string) => `${head} ${glyphed(s)}`);
      expect(stripAnsi(renderRunDetail(r, ANSI))).toBe(expected);
    });
    const list = renderRunList(fx.runs, ANSI).split('\n');
    expect(list[0]).toBe(
      `${B('run00002')}  ${R('✗ failed ')} ship-it  ${D('steps=')}1/3  ${D('maxC=')}2  ${D('2026-10-17T09:30:00.000Z')}`,
    );
    // Each row = the plain row with a one-column glyph + space before the padded status, so
    // the columns shift uniformly and line up exactly as they do in plain.
    const plainRows = g('runList').split('\n');
    stripAnsi(renderRunList(fx.runs, ANSI))
      .split('\n')
      .forEach((row, i) => {
        const r = fx.runs[i]!;
        expect(row).toBe(plainRows[i]!.replace(`${r.id}  `, `${r.id}  ${TONE_STYLES[toneOf(r.status)!].glyph} `));
      });
  });

  test('settings: labels dim, unset values dim, a refused host note in yellow, used files green', () => {
    const lines = renderSettingsView(fx.settingsViews[0]!, ANSI).split('\n');
    expect(lines[0]).toBe(
      `${D('host          ')}studio:8787     ${D(' (local: /home/u/src/orc/.orc/settings.toml)')}` +
        `${Y(' — refused: not a trusted peer (orc remote add studio, or --local/--host)')}`,
    );
    expect(lines[1]).toBe(`${D('provider      ')}${D('-               ')}${D(' (default)')}${D(' — spawn requires --provider')}`);
    expect(lines).toContain(`  ${D('local  ')}${G('used           ')}/home/u/src/orc/.orc/settings.toml`);
    expect(lines).toContain(`  ${D('local  ')}${D('missing        ')}${D('/home/u/src/orc/pkg/.orc/settings.toml')}`);
    expect(lines).toContain(BY('warnings:'));
    fx.settingsViews.forEach((v, i) => expect(stripAnsi(renderSettingsView(v, ANSI))).toBe(gl('settings')[i]!));
  });

  test('transcripts: role labels distinct, tool lines dim', () => {
    expect(renderTurns(fx.turns, ANSI).split('\n')).toEqual([
      `${BC('<user>')} Fix the flaky test`,
      'and explain why it flaked.',
      D('  [Bash: bun test test/wait.test.ts]'),
      D('  [Read …/src/session.ts]'),
      `${BM('<assistant>')} The wait loop raced the journal fsync.`,
      '',
      '- Added a barrier',
      '- Re-ran 50x: green',
      `${DI('<system>')} context compacted`,
    ]);
    expect(stripAnsi(renderTurns(fx.turns, ANSI))).toBe(g('turns'));
  });

  test('journal (orc attach): markers coloured by meaning', () => {
    const lines = fx.journal.map((e) => renderJournalEntry(e, ANSI));
    expect(lines).toEqual([
      D('· actor started (pid 9001, fresh)'),
      null,
      D('· provider ready (session prov-123)'),
      null,
      `${BC('>')} hello there\n  second line`,
      null,
      'Hi! Working on it.\nDone.',
      G('· turn completed $0.0123'),
      `${BC('>')} do the risky thing`,
      `${Y('? permission requested')} ${D('(denied: orc runs providers without approvals)')}`,
      `${R('! turn failed:')} permission denied`,
      D('· interrupt requested'),
      Y('! turn interrupted (user)'),
      G('· turn completed'),
      D('· provider exited (code=0 signal=null)'),
      D('· actor stopped (stop)'),
      D('· session reopened'),
      R('· actor stopped (error: lease lost to pid 77)'),
    ]);
    expect(stripAnsi(renderJournal(fx.journal, ANSI))).toBe(g('journal'));
  });

  test('error and warning lines', () => {
    expect(formatError('no session found', ANSI)).toBe(`${BR('error:')} no session found\n`);
    expect(formatError('no session found')).toBe('error: no session found\n');
    expect(formatWarning('peer x unreachable', ANSI)).toBe(`${BY('warning:')} peer x unreachable\n`);
    expect(formatWarning('peer x unreachable')).toBe('warning: peer x unreachable\n');
  });

  test('help: headings bold, commands bold cyan, flags cyan, placeholders italic; text unchanged', () => {
    const help = renderHelp(ANSI);
    expect(stripAnsi(help)).toBe(HELP_TEXT);
    const lines = help.split('\n');
    expect(lines[0]).toBe(B('orc — multi-agent orchestration CLI'));
    expect(lines[2]).toBe(B('Usage:'));
    expect(lines[3]).toBe(
      `  ${BC('orc spawn')}  ${C('--provider')} ${w('3', '23')('<claude|pi>')} [options]   Launch a new agent session`,
    );
    expect(lines).toContain(B('Global:'));
    expect(lines).toContain(`  ${BC('orc workflow run')} ${w('3', '23')('<file>')} [${C('--detach')}] [${C('--json')}] [${C('--max-concurrency')} N]`);
    // Words with inner hyphens are not mistaken for flags.
    expect(help).toContain('non-zero');
    expect(help).not.toContain(C('-zero'));
  });
});
