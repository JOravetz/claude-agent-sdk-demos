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
const INLINE_CHAR_BUDGET = 200_000;
const MAX_SCOUTS = 6;
const MIN_FILES_FOR_FANOUT = 5;
const SCOUT_BUCKET_TARGET_SIZE = 8;

interface ManifestFile { relPath: string; absPath: string; size: number; }
type Context =
  | { kind: 'inline'; root: string; text: string }
  | { kind: 'manifest'; root: string; files: ManifestFile[]; totalBytes: number; clusters: ManifestFile[][] };

function partitionManifest(files: ManifestFile[]): ManifestFile[][] {
  if (files.length < MIN_FILES_FOR_FANOUT) return [];
  const k = Math.max(2, Math.min(MAX_SCOUTS, Math.ceil(files.length / SCOUT_BUCKET_TARGET_SIZE)));
  const buckets: { files: ManifestFile[]; bytes: number }[] = Array.from({ length: k }, () => ({ files: [], bytes: 0 }));
  for (const f of [...files].sort((a, b) => b.size - a.size)) {
    const smallest = buckets.reduce((best, b) => (b.bytes < best.bytes ? b : best));
    smallest.files.push(f);
    smallest.bytes += f.size;
  }
  return buckets.map(b => b.files);
}

function loadContext(p: string): Context {
  const stat = fs.statSync(p);
  const root = path.resolve(p);

  if (stat.isFile()) {
    const text = fs.readFileSync(p, 'utf-8');
    if (text.length > INLINE_CHAR_BUDGET) {
      throw new Error(
        `Context file is ${text.length.toLocaleString()} chars, exceeds the ` +
        `${INLINE_CHAR_BUDGET.toLocaleString()}-char inline budget. ` +
        `Trim the file, or split into a directory and pass that — directory mode ` +
        `produces a manifest the lead reads on demand and scales to large corpora.`
      );
    }
    console.log(`📎 Inlining context file: ${root} (${text.length.toLocaleString()} chars)`);
    return { kind: 'inline', root, text };
  }

  if (!stat.isDirectory()) throw new Error(`Context path is neither a file nor a directory: ${p}`);

  const files: ManifestFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push({
          relPath: path.relative(root, full),
          absPath: full,
          size: fs.statSync(full).size,
        });
      }
    }
  };
  walk(p);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (files.length === 0) throw new Error(`No text files (${[...TEXT_EXTENSIONS].join(', ')}) found in ${p}`);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const clusters = partitionManifest(files);
  console.log(`📁 Manifest mode: ${files.length} file(s) discoverable in ${root} (${totalBytes.toLocaleString()} bytes total).`);
  for (const f of files) console.log(`   - ${f.relPath} (${f.size.toLocaleString()} bytes)`);
  if (clusters.length > 0) {
    console.log(`🛰️  Scout fan-out: dispatching ${clusters.length} scouts in parallel.`);
    clusters.forEach((c, i) => {
      const bytes = c.reduce((s, f) => s + f.size, 0);
      console.log(`   Cluster ${i + 1}: ${c.length} file(s), ${bytes.toLocaleString()} bytes`);
    });
  } else {
    console.log(`   (below ${MIN_FILES_FOR_FANOUT}-file fan-out threshold; lead will Read directly)`);
  }
  return { kind: 'manifest', root, files, totalBytes, clusters };
}

const RESEARCHER_PROMPT = `You are a research subagent that supplements user-provided CV context with public web findings.

The Lead Agent invokes you with a specific list of gaps to fill (e.g., "find current LinkedIn URL", "verify dates at company X", "find recent GitHub activity").

OUTPUT: A short markdown report of findings, including source URLs. If a search returns no good match, say so explicitly. NEVER fabricate facts — if uncertain, omit.

CONSTRAINTS:
- Web findings supplement but do NOT override the user's context document.
- Limit to 5–8 search queries total per invocation.
- Prefer authoritative sources (LinkedIn, GitHub, professional society profiles, employer pages, news outlets).
- Return concise findings — the Lead Agent will integrate them into the resume.`;

const SCOUT_PROMPT = `You are a scout subagent. The Lead Agent gives you a list of absolute file paths drawn from a CV-context corpus too large to inline. Your job is to Read every file in your assigned list and return a condensed, structured findings report the Lead can merge with reports from other scouts.

WORKFLOW:
1. Read every file in the list (use the Read tool; absolute paths are provided).
2. Extract anything that could appear on a resume — never fabricate.
3. Return markdown with the sections below, omitting any section you found nothing for.

OUTPUT SECTIONS (in this order):
## Roles & Dates
## Discoveries / Projects
## Skills & Tools
## Education / Credentials
## Notable Phrasing
(verbatim quotes worth reusing on the resume)
## Gaps or Conflicts
(facts that contradict between files, or that look incomplete)

CONSTRAINTS:
- For each fact, cite the source filename in parentheses, e.g. "(Geng_North_Discovery_Documentation.md)".
- Deduplicate within your own report; don't worry about overlap with other scouts — the Lead handles cross-scout dedup.
- Be concise. The Lead is reading K of these and has finite context.
- NEVER fabricate. If a file is irrelevant (e.g. a cover letter with no new CV facts), say so in one line and skip it.`;

const MY_AGENT_TYPES = new Set(['researcher', 'scout']);

function leadSystemPrompt(pages: number, expectedPath: string, cwd: string): string {
  const pageFit = pages === 1
    ? 'Max 3 roles, 2-line summary, 2-line skills, bullets 80–100 chars'
    : pages === 2
      ? 'Up to 6 roles, 4–5 line summary, categorized skills, bullets 100–150 chars'
      : 'All relevant roles, detailed summary, full skills taxonomy, bullets 120–180 chars';

  return `You are the LEAD AGENT coordinating creation of a ${pages}-page .docx resume.

You have two subagent types available via the Task tool:
- "scout" — Read-only subagent that ingests a cluster of context files and returns structured markdown findings. Use one per cluster when SCOUT CLUSTERS are present in the user prompt.
- "researcher" — supplements the user's context with public web findings (LinkedIn URL, GitHub, recent news). Spawn ONLY when the context has clear gaps to fill.

You also have AskUserQuestion for interactive clarification.

WORKFLOW:

STEP 0 — Scout fan-out (MANDATORY when SCOUT CLUSTERS are present):
Dispatch one "scout" Task call per cluster IN THE SAME ASSISTANT MESSAGE (parallel tool_use blocks). Do NOT serialize. Do NOT skip clusters. Each scout's Task prompt MUST include (a) the cluster's absolute file paths, one per line, and (b) the instruction: "Read every listed file and return your structured findings per your system prompt." After all scouts return, aggregate their findings in your own context. Do NOT Read additional files yourself unless a critical gap remains after aggregation.

STEP 1 — Clarify intent (AskUserQuestion, optional):
If the user's request and context together don't make obvious the audience, focus, or priorities, use AskUserQuestion to ask 1–3 strategic questions. Skip entirely when the answers are obvious. Never ask more than 3 questions.

STEP 2 — Research (Task, optional):
If a CV context was provided AND there are identifiable gaps, spawn "researcher" with a specific gap list. If no context was provided, spawn "researcher" with the person's name to gather information. Skip if context is comprehensive.

STEP 3 — Draft + Generate docx:
- Synthesize the inputs (inline context OR aggregated scout findings, plus any researcher findings and clarifying answers) into a structured ${pages}-page resume. Do this work yourself — a separate draft step would only introduce errors.
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

async function generateResume(personName: string, context: Context | undefined, pages: number) {
  console.log(`\n📝 Generating ${pages}-page resume for: ${personName}\n`);
  if (context?.kind === 'inline') console.log(`📎 Inline context: ${context.text.length.toLocaleString()} chars\n`);
  if (context?.kind === 'manifest') console.log(`📁 Manifest: ${context.files.length} file(s), ${context.totalBytes.toLocaleString()} bytes available\n`);
  console.log('='.repeat(50));

  const cwd = process.cwd();
  const outputDir = path.join(cwd, 'agent', 'custom_scripts');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const expectedPath = path.join(outputDir, 'resume.docx');
  fs.rmSync(expectedPath, { force: true });

  const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
  const myAgentIds = new Set<string>();

  const pathInstruction = `Write the resume to exactly this absolute path: ${expectedPath} — no other location.`;

  const manifestBlock = context?.kind === 'manifest'
    ? context.files.map(f => `${f.absPath} (${f.size} bytes)`).join('\n')
    : '';

  const scoutClustersBlock = context?.kind === 'manifest' && context.clusters.length > 0
    ? context.clusters.map((c, i) => {
        const bytes = c.reduce((s, f) => s + f.size, 0);
        const paths = c.map(f => `  ${f.absPath}`).join('\n');
        return `<cluster id="${i + 1}" files="${c.length}" bytes="${bytes}">\n${paths}\n</cluster>`;
      }).join('\n')
    : '';

  const prompt = !context
    ? `Research "${personName}" and create a professional ${pages}-page resume as a .docx file.

${pathInstruction}

No CV context was provided; spawn the researcher subagent first to gather information about this person, then generate the docx.`
    : context.kind === 'inline'
      ? `Create a professional ${pages}-page resume as a .docx file for "${personName}".

${pathInstruction}

Follow the workflow in your system prompt: optional AskUserQuestion → optional researcher → drafter → docx generation. The CONTEXT below is the authoritative source.

<context>
${context.text}
</context>`
      : context.clusters.length > 0
        ? `Create a professional ${pages}-page resume as a .docx file for "${personName}".

${pathInstruction}

The corpus under ${context.root} is too large to inline (${context.totalBytes.toLocaleString()} bytes across ${context.files.length} files). It has been partitioned into ${context.clusters.length} size-balanced clusters below. Per your system prompt STEP 0, dispatch one "scout" Task in parallel for each cluster IN THE SAME ASSISTANT MESSAGE. Each scout's Task prompt must list its cluster's absolute paths and instruct the scout to Read every file and return structured findings.

<scout-clusters root="${context.root}" total-bytes="${context.totalBytes}">
${scoutClustersBlock}
</scout-clusters>

After all scouts return, aggregate their findings, then continue with the rest of the workflow (optional AskUserQuestion → optional researcher to fill gaps → drafter → docx generation).`
        : `Create a professional ${pages}-page resume as a .docx file for "${personName}".

${pathInstruction}

The CONTEXT MANIFEST below lists every text file available to you under ${context.root} (${context.totalBytes.toLocaleString()} bytes total). The corpus is small enough that scout fan-out was skipped; Read the files yourself. Pick the few most relevant to a ${pages}-page resume (prefer recent comprehensive CVs and summary docs; skip duplicates, older variants, drafts, and cover letters unless they're the only source), then continue with the rest of the workflow.

<context-manifest root="${context.root}">
${manifestBlock}
</context-manifest>`;

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
          scout: {
            description: 'Reads a cluster of CV-context files (paths supplied by the lead) and returns structured markdown findings: roles & dates, discoveries, skills, education, notable phrasing, gaps. Use one scout per manifest cluster, dispatched in parallel.',
            tools: ['Read'],
            prompt: SCOUT_PROMPT,
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

let context: Context | undefined;
if (contextPath) {
  if (!fs.existsSync(contextPath)) {
    console.error(`Error: context path not found: ${contextPath}`);
    process.exit(1);
  }
  try {
    context = loadContext(contextPath);
  } catch (err) {
    console.error(`Error loading context: ${(err as Error).message}`);
    process.exit(1);
  }
}

generateResume(personName, context, pages).catch(console.error);
