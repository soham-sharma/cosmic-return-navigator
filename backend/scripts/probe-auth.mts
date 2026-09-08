/**
 * Diagnostic: find which auth configuration the Agent SDK's bundled CLI needs
 * for a third-party Anthropic-compatible proxy.
 *
 * The raw Messages API accepts this key over `x-api-key`, so the credential is
 * good; the question is purely how the CLI forwards it.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const KEY = process.env.PROBE_KEY!;
const BASE = process.env.PROBE_BASE!;
const MODEL = process.env.PROBE_MODEL ?? 'claude-opus-5';

const configs: { name: string; env: Record<string, string | undefined> }[] = [
  { name: 'ANTHROPIC_API_KEY only', env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: undefined } },
  { name: 'ANTHROPIC_AUTH_TOKEN only', env: { ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_API_KEY: undefined } },
  { name: 'both API_KEY + AUTH_TOKEN', env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: BASE } },
  {
    name: 'API_KEY + CLAUDE_CODE_API_BASE_URL',
    env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: BASE, CLAUDE_CODE_API_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: undefined },
  },
  {
    name: 'API_KEY + custom x-api-key header',
    env: {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: BASE,
      ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${KEY}`,
      ANTHROPIC_AUTH_TOKEN: undefined,
    },
  },
];

async function attempt(name: string, extraEnv: Record<string, string | undefined>) {
  process.stdout.write(`\n[${name}]\n`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  try {
    let text = '';
    let outcome = 'no result message';

    for await (const message of query({
      prompt: 'Reply with exactly: OK',
      options: {
        model: MODEL,
        systemPrompt: 'You reply with exactly the requested token and nothing else.',
        maxTurns: 1,
        allowedTools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'],
        settingSources: [],
        persistSession: false,
        abortController: controller,
        env: { ...process.env, ...extraEnv } as Record<string, string>,
      },
    })) {
      const m = message as Record<string, unknown>;
      if (m.type === 'result') {
        outcome = String(m.subtype);
        if (typeof m.result === 'string') text = m.result;
        if (Array.isArray(m.errors) && m.errors.length) outcome += ` | ${m.errors.join('; ')}`;
      }
    }

    if (outcome === 'success') {
      console.log(`  ✅ SUCCESS — model replied: ${JSON.stringify(text.trim().slice(0, 60))}`);
      return true;
    }
    console.log(`  ❌ ${outcome}`);
    return false;
  } catch (err) {
    console.log(`  ❌ threw: ${(err instanceof Error ? err.message : String(err)).slice(0, 220)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const main = async () => {
  console.log('='.repeat(78));
  console.log(`Agent SDK auth probe — base=${BASE} model=${MODEL}`);
  console.log('='.repeat(78));

  for (const c of configs) {
    if (await attempt(c.name, c.env)) {
      console.log(`\nWINNER: ${c.name}`);
      return;
    }
  }
  console.log('\nNo configuration succeeded.');
};

void main();
