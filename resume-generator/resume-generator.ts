/**
 * Resume Generator using Claude Agent SDK
 *
 * Multi-agent orchestration with terminal-based AskUserQuestion (adapts the
 * ask-user-question-previews demo's canUseTool round-trip for a CLI) and
 * researcher/drafter subagents (adapts the research-agent demo's pattern).
 *
 * Usage: npx tsx resume-generator.ts "Name" [--context FILE_OR_DIR] [--pages N]
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'node:readline/promises';
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process';

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text', '.json', '.yaml', '.yml']);

function loadContext(p: string): string {
  const stat = fs.statSync(p);
  if (stat.isFile()) return fs.readFileSync(p, 'utf-8');
  if (!stat.isDirectory()) throw new Error(`Context path is neither a file nor a directory: ${p}`);

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  walk(p);
  files.sort();

  if (files.length === 0) throw new Error(`No text files (${[...TEXT_EXTENSIONS].join(', ')}) found in ${p}`);

  console.log(`📁 Loading ${files.length} context file(s) from ${p}:`);
  const root = path.resolve(p);
  const parts = files.map(f => {
    const rel = path.relative(root, f);
    const body = fs.readFileSync(f, 'utf-8');
    console.log(`   - ${rel} (${body.length} chars)`);
    return `<file path="${rel}">\n${body}\n</file>`;
  });
  return parts.join('\n\n');
}

const RESEARCHER_PROMPT = `You are a research subagent that supplements user-provided CV context with public web findings.

The Lead Agent invokes you with a specific list of gaps to fill (e.g., "find current LinkedIn URL", "verify dates at company X", "find recent GitHub activity").

OUTPUT: A short markdown report of findings, including source URLs. If a search returns no good match, say so explicitly. NEVER fabricate facts — if uncertain, omit.

CONSTRAINTS:
- Web findings supplement but do NOT override the user's context document.
- Limit to 5–8 search queries total per invocation.
- Prefer authoritative sources (LinkedIn, GitHub, professional society profiles, employer pages, news outlets).
- Return concise findings — the Lead Agent will integrate them into the resume.`;

const MY_AGENT_TYPES = new Set(['researcher']);

function leadSystemPrompt(pages: number, expectedPath: string, cwd: string): string {
  const pageFit = pages === 1
    ? 'Max 3 roles, 2-line summary, 2-line skills, bullets 80–100 chars'
    : pages === 2
      ? 'Up to 6 roles, 4–5 line summary, categorized skills, bullets 100–150 chars'
      : 'All relevant roles, detailed summary, full skills taxonomy, bullets 120–180 chars';

  return `You are the LEAD AGENT coordinating creation of a ${pages}-page .docx resume.

You have one subagent available via the Task tool:
- "researcher" — supplements the user's context with public web findings (LinkedIn URL, GitHub, recent news). Spawn ONLY when the context has clear gaps to fill.

You also have AskUserQuestion for interactive clarification.

WORKFLOW:

STEP 1 — Clarify intent (AskUserQuestion, optional):
If the user's request and context together don't make obvious the audience, focus, or priorities, use AskUserQuestion to ask 1–3 strategic questions. Skip entirely when the answers are obvious. Never ask more than 3 questions.

STEP 2 — Research (Task, optional):
If a CV context was provided AND there are identifiable gaps, spawn "researcher" with a specific gap list. If no context was provided, spawn "researcher" with the person's name to gather information. Skip if context is comprehensive.

STEP 3 — Draft + Generate docx:
- Synthesize the context (and any researcher findings + clarifying answers) into a structured ${pages}-page resume. Do this work yourself — you have direct access to the source material, so a separate draft step would only introduce errors.
- Invoke Skill(name="docx") to load instructions, then Read .claude/skills/docx/docx-js.md fully.
- Write a CommonJS-style JavaScript file to: ${cwd}/agent/custom_scripts/generate_resume.js
- Run it via Bash so the .docx lands at: ${expectedPath}

REQUIRED OUTPUT PATH — do not deviate:
- The final resume MUST be written to: ${expectedPath}
- Do NOT use any other path or filename. Working directory is ${cwd} — do NOT cd elsewhere. The host wipes ${expectedPath} before each run, so the file must appear there or the run is reported as failed.

PAGE FIT for ${pages} page(s):
- 0.5 inch margins, Name 24pt, Headers 12pt, Body 10pt
- ${pageFit}

ACCURACY: never fabricate dates, employers, titles, or quantitative claims. Vague placeholders ("Earlier roles") are fine when real dates are unknown.`;
}

function createCanUseToolHandler(rl: readline.Interface) {
  const isTty = stdinStream.isTTY === true;

  return async function(toolName: string, toolInput: Record<string, unknown>) {
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'allow' as const, updatedInput: toolInput };
    }
    const questions = (toolInput as any).questions as Array<{
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;

    const answers: string[] = [];
    console.log('\n' + '─'.repeat(60));
    console.log(isTty
      ? '🤔 Claude needs your input:'
      : '🤔 Claude asked clarifying questions (no TTY — auto-answering):');

    for (const q of questions) {
      console.log('\n' + q.question);
      q.options.forEach((opt, i) => {
        const desc = opt.description ? `\n     ${opt.description}` : '';
        console.log(`  ${i + 1}. ${opt.label}${desc}`);
      });

      if (!isTty) {
        const recIdx = q.options.findIndex(o => /\bRecommended\b/i.test(o.label));
        const idx = recIdx >= 0 ? recIdx : 0;
        const tag = recIdx >= 0 ? '(Recommended)' : '(first option — no Recommended found)';
        console.log(`  → auto-selected #${idx + 1} ${tag}: ${q.options[idx].label}`);
        answers.push(q.options[idx].label);
        continue;
      }

      console.log(`  ${q.options.length + 1}. (other) type your own answer`);
      const reply = (await rl.question('> ')).trim();
      const idx = parseInt(reply, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < q.options.length) {
        answers.push(q.options[idx].label);
      } else if (!isNaN(idx) && idx === q.options.length) {
        const custom = (await rl.question('Your answer: ')).trim();
        answers.push(custom || 'No answer');
      } else {
        answers.push(reply || 'No answer');
      }
    }
    console.log('─'.repeat(60) + '\n');
    return {
      behavior: 'allow' as const,
      updatedInput: { questions, answers },
    };
  };
}

async function generateResume(personName: string, context: string | undefined, pages: number) {
  console.log(`\n📝 Generating ${pages}-page resume for: ${personName}\n`);
  if (context) console.log(`📎 Context document: ${context.length} chars\n`);
  console.log('='.repeat(50));

  const cwd = process.cwd();
  const outputDir = path.join(cwd, 'agent', 'custom_scripts');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const expectedPath = path.join(outputDir, 'resume.docx');
  fs.rmSync(expectedPath, { force: true });

  const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
  const myAgentIds = new Set<string>();

  const pathInstruction = `Write the resume to exactly this absolute path: ${expectedPath} — no other location.`;

  const prompt = context
    ? `Create a professional ${pages}-page resume as a .docx file for "${personName}".

${pathInstruction}

Follow the workflow in your system prompt: optional AskUserQuestion → optional researcher → drafter → docx generation. The CONTEXT below is the authoritative source.

<context>
${context}
</context>`
    : `Research "${personName}" and create a professional ${pages}-page resume as a .docx file.

${pathInstruction}

No CV context was provided; spawn the researcher subagent first to gather information about this person, then drafter, then generate the docx.`;

  console.log('\n🔍 Running multi-agent resume pipeline...\n');

  try {
    const q = query({
      prompt,
      options: {
        maxTurns: 50,
        cwd,
        model: 'sonnet',
        // Lead agent has no direct web access — that's the researcher's job.
        allowedTools: ['Task', 'AskUserQuestion', 'Skill', 'Bash', 'Write', 'Read', 'Edit', 'Glob'],
        settingSources: ['project'],
        systemPrompt: leadSystemPrompt(pages, expectedPath, cwd),
        agents: {
          researcher: {
            description: 'Supplements user-provided CV context with public web findings (LinkedIn URL, GitHub profile, recent news). Returns concise markdown findings with sources.',
            tools: ['WebSearch', 'WebFetch'],
            prompt: RESEARCHER_PROMPT,
            model: 'sonnet',
          },
        },
        canUseTool: createCanUseToolHandler(rl),
        hooks: {
          // Track which subagent IDs are ours so the Stop hook can attribute correctly.
          SubagentStart: [{
            hooks: [async (input: any) => {
              const t = input.agent_type;
              const id = input.agent_id ?? '';
              if (t && MY_AGENT_TYPES.has(t)) {
                myAgentIds.add(id);
                console.log(`\n   ↳ Subagent started: ${t} (${id.slice(0, 8)}…)`);
              }
              return { continue: true };
            }],
          }],
          SubagentStop: [{
            hooks: [async (input: any) => {
              const id = input.agent_id ?? '';
              if (myAgentIds.has(id)) {
                console.log(`   ↳ Subagent finished: ${id.slice(0, 8)}…`);
                myAgentIds.delete(id);
              }
              return { continue: true };
            }],
          }],
        },
      },
    });

    for await (const msg of q) {
      if (msg.type === 'assistant' && msg.message) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            console.log(block.text);
          }
          if (block.type === 'tool_use') {
            const name = block.name;
            const input = block.input as any;
            if (name === 'Task') {
              const sub = input?.subagent_type ?? '?';
              console.log(`\n🤖 Delegating to subagent: ${sub}`);
            } else if (name === 'AskUserQuestion') {
              // Output handled by canUseTool; skip duplicate logging.
            } else if (name === 'WebSearch' && typeof input?.query === 'string') {
              console.log(`\n🔍 Searching: "${input.query}"`);
            } else {
              console.log(`\n🔧 Using tool: ${name}`);
            }
          }
        }
      }
      if (msg.type === 'result' && msg.subtype === 'tool_result') {
        const resultStr = JSON.stringify(msg.content).slice(0, 200);
        console.log(`   ↳ Result: ${resultStr}${resultStr.length >= 200 ? '...' : ''}`);
      }
    }
  } finally {
    rl.close();
  }

  if (fs.existsSync(expectedPath)) {
    console.log('\n' + '='.repeat(50));
    console.log(`📄 Resume saved to: ${expectedPath}`);
    console.log('='.repeat(50) + '\n');
    return;
  }

  console.log('\n❌ Resume file was not created at the expected path.');
  const stray: string[] = [];
  const sweep = (dir: string) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sweep(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.docx')) stray.push(full);
    }
  };
  sweep(cwd);
  const parentAgent = path.join(cwd, '..', 'agent');
  if (fs.existsSync(parentAgent)) sweep(parentAgent);
  if (stray.length > 0) {
    console.log('\n⚠️  Found .docx file(s) at unexpected locations:');
    for (const s of stray) console.log(`   - ${s}`);
    console.log(`\nExpected: ${expectedPath}`);
  }
}

// --- Main ---
const rawArgs = process.argv.slice(2);

function popFlag(args: string[], long: string, short?: string): string | undefined {
  const idx = args.findIndex(a => a === long || (short && a === short));
  if (idx === -1) return undefined;
  const val = args[idx + 1];
  if (!val || val.startsWith('-')) {
    console.error(`Error: ${long} requires a value.`);
    process.exit(1);
  }
  args.splice(idx, 2);
  return val;
}

const contextPath = popFlag(rawArgs, '--context', '-c');
const pagesArg = popFlag(rawArgs, '--pages', '-p');
const personName = rawArgs[0];

if (!personName) {
  console.log('Usage: npx tsx resume-generator.ts "Person Name" [--context path] [--pages N]');
  console.log('Examples:');
  console.log('  npx tsx resume-generator.ts "Jane Doe"');
  console.log('  npx tsx resume-generator.ts "Jane Doe" --context my-cv.md');
  console.log('  npx tsx resume-generator.ts "Jane Doe" --context ./resume-context/ --pages 2');
  process.exit(1);
}

let pages = 1;
if (pagesArg !== undefined) {
  const parsed = parseInt(pagesArg, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 5) {
    console.error(`Error: --pages must be an integer between 1 and 5, got ${pagesArg}`);
    process.exit(1);
  }
  pages = parsed;
}

let contextText: string | undefined;
if (contextPath) {
  if (!fs.existsSync(contextPath)) {
    console.error(`Error: context path not found: ${contextPath}`);
    process.exit(1);
  }
  try {
    contextText = loadContext(contextPath);
  } catch (err) {
    console.error(`Error loading context: ${(err as Error).message}`);
    process.exit(1);
  }
}

generateResume(personName, contextText, pages).catch(console.error);
