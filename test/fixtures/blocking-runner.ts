/**
 * A real detached workflow runner whose single step blocks forever (no agent). It wires
 * the SDK exactly like the CLI runner entrypoints do: self-reported `runner`, the
 * SIGTERM trap, and runWorkflow's abort signal.
 *
 * usage: blocking-runner.ts <runId> [leaseMs]
 */
import { runWorkflow } from '../../src/workflow.ts';
import { currentRunnerInfo, trapRunnerTermination } from '../../src/workflow-runner.ts';

const [runId, leaseArg] = process.argv.slice(2);
if (!runId) {
  process.stderr.write('usage: blocking-runner.ts <runId> [leaseMs]\n');
  process.exit(2);
}
const term = trapRunnerTermination();
const run = await runWorkflow(
  { name: 'blocking', steps: [{ id: 'a', provider: 'claude', prompt: 'x' }] },
  {
    runId,
    runner: currentRunnerInfo(runId),
    signal: term.signal,
    leaseMs: leaseArg ? Number(leaseArg) : undefined,
    execStep: () => new Promise(() => {}),
    onEvent: (e) => process.stdout.write(`event ${e.type}\n`),
  },
);
term.dispose();
process.stdout.write(`exit ${term.signal.aborted ? 'aborted' : 'finished'} ${run.status}\n`);
process.exit(term.signal.aborted ? 143 : 0);
