/**
 * orc --local workflow run orc.workflows/research.ts --prompt "Your research question"
 * Optional: --keep-sessions-on-error to inspect live sessions after a failure.
 */
import type { WorkflowDef } from '../src/workflow.ts';
import type { WorkflowContext } from '../src/workflow-loader.ts';

export default function research({ prompt }: WorkflowContext): WorkflowDef {
    if (!prompt?.trim()) {
        throw new Error('research requires --prompt "Your research question"');
    }
    return {
        name: 'research',
        policy: { maxDepth: 1, maxSessions: 5 },
        steps: [
            {
                id: 'search-query-optimizer',
                provider: 'pi',
                model: 'openai/gpt-6.1-sol',
                reasoningEffort: 'medium',
                prompt:
                    `Optimize this research question into a precise search brief:\n\n${prompt}\n\n` +
                    'Preserve the intent, state assumptions, and identify useful search terms. ' +
                    'Write the brief to optimized-query.txt in your current working directory. ' +
                    'You must create that file; replying with the brief alone is insufficient. ' +
                    'Do not modify other files or commit changes.',
                outputs: [{ name: 'optimized-query', path: 'optimized-query.txt', required: true }],
                verify: { artifact: { name: 'optimized-query' } },
            },
            {
                id: 'search-runner',
                provider: 'claude',
                model: 'haiku',
                reasoningEffort: 'high',
                // inputs also establishes a dependency on the producing step; needs is optional.
                inputs: [{
                    name: 'query',
                    fromStep: 'search-query-optimizer',
                    artifact: 'optimized-query',
                    materializeAs: 'optimized-query.txt',
                }],
                prompt:
                    'Read the research brief at ${inputs.query}. Research it using web searches, ' +
                    'prioritizing current primary sources. Do not delegate to other agents. ' +
                    'Write search-results.json in your current working directory with an object ' +
                    'containing question (string), answer (string), sources (array of objects with ' +
                    'title and url), and caveats (array of strings). Cite sources in the answer, ' +
                    'record the verification date, and distinguish evidence from assumptions. ' +
                    'You must create the JSON file; a chat response alone is insufficient. ' +
                    'Do not modify other files or commit changes.',
                outputs: [{ name: 'search-results', path: 'search-results.json', required: true }],
                verify: {
                    all: [
                        { artifact: { name: 'search-results' } },
                        {
                            file: {
                                path: 'search-results.json', json: true,
                                requiredKeys: ['question', 'answer', 'sources', 'caveats']
                            }
                        },
                    ]
                },
            },
        ],
    };
}
