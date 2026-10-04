# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the **Claude Agent SDK Demos** repository containing multiple demonstration applications built with the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-overview). The SDK enables developers to programmatically create autonomous AI agents that spawn Claude Code processes and interact with them via stdin/stdout communication.

**Important**: All applications are demos for local development only and not designed for production deployment.

## Project Structure

The repository contains four distinct demo applications, each in its own directory with independent setup and build processes:

### 1. **hello-world** (TypeScript/Node.js)
- **Purpose**: Basic getting-started example demonstrating the core SDK concepts
- **Tech**: Node.js with TypeScript
- **Build**: `npx tsx hello-world.ts`
- **Key Concepts**:
  - Query function and message iteration
  - Hook system for tool usage control (PreToolUse hooks)
  - File operation restrictions via hooks
  - Agent configuration (maxTurns, cwd, model selection)

### 2. **research-agent** (Python)
- **Purpose**: Multi-agent research system that breaks tasks into subtopics and spawns parallel researcher agents
- **Tech**: Python 3.13+, uses UV package manager
- **Build**: `uv sync` then `uv run research_agent/agent.py`
- **Key Concepts**:
  - Multi-agent coordination
  - Parallel agent spawning via Task tool
  - Subagent activity tracking with SDK hooks
  - Web search integration
  - File-based findings synthesis

### 3. **email-agent** (TypeScript/Node.js + React + SQLite)
- **Purpose**: IMAP email assistant with web UI (full-stack application)
- **Tech**: Bun runtime, React frontend, Express/Node.js backend, SQLite database
- **Build**: `bun install` then `bun run dev`
- **Key Concepts**:
  - Full-stack application with Bun
  - Email credential management (IMAP)
  - AI-powered email search and assistance
  - UI state management with Jotai
  - Subagent integration for email tasks
  - Database migrations and schema

### 4. **excel-demo** (TypeScript + Electron + React + Python)
- **Purpose**: Desktop application for AI-powered spreadsheet creation and analysis
- **Tech**: Electron, React, TypeScript, Python scripts, Webpack
- **Build**: `npm install` then `npm start` (uses npm)
- **Key Concepts**:
  - Electron desktop application
  - Python agent integration for spreadsheet generation
  - ExcelJS and XLSX libraries for spreadsheet manipulation
  - Complex build pipeline with Webpack

## Common Development Commands

### Package Management
- **hello-world**: npm (native Node.js)
- **research-agent**: UV (Python package manager)
- **email-agent**: Bun runtime
- **excel-demo**: npm

Each demo uses its specified package manager exclusively - do not mix them.

### Running Demos

```bash
# hello-world
npx tsx hello-world.ts

# research-agent (from research-agent directory)
uv sync
uv run research_agent/agent.py

# email-agent (from email-agent directory)
bun install
bun run dev

# excel-demo (from excel-demo directory)
npm install
npm start
```

### Linting and Testing

**email-agent**:
```bash
bun run test              # Run tests
bun run test:watch       # Watch mode
bun run test:coverage    # Coverage report
bun run knip            # Unused code detection
```

**excel-demo**:
```bash
npm run lint             # Run ESLint
npm run lint:fix         # Fix lint issues
npm test                 # Run Jest tests
```

## Key Architectural Patterns

### SDK Query Function
All demos use the core SDK pattern:
```typescript
const q = query({
  prompt: '...',
  options: {
    maxTurns: 100,
    cwd: '/path/to/agent',
    model: 'opus'|'sonnet'|'haiku'|'inherit',
    executable: 'node',
    allowedTools: [...],
    hooks: { /* optional */ }
  }
});

for await (const message of q) {
  // Process messages (type: 'system'|'assistant'|'result')
}
```

### Hook System
Hooks intercept tool usage before execution. Common patterns:
- **PreToolUse**: Validate/block/modify tools before execution
- Tool matchers: `"Write|Edit|MultiEdit"`, `"Bash"`, etc.
- Returns: `{ continue: true }` to allow, `{ decision: 'block', stopReason: '...', continue: false }` to deny

**Example** (hello-world): Restricts `.js`/`.ts` files to `custom_scripts/` directory

### Multi-Agent Patterns
- **research-agent**: Uses Task tool to spawn parallel subagents
- **email-agent**: Subagents in `agent/.claude/agents/` directory
- Communication via SDK's task spawning system

### Message Types
The SDK returns three message types in the async iterable:
- `system`: System-level information
- `assistant`: Claude's responses (access via `message.message.content`)
- `result`: Tool execution results

## SDK Configuration

### Model Selection
- `"opus"`: Largest model, best for complex reasoning
- `"sonnet"`: Balanced, recommended for most tasks
- `"haiku"`: Fast and cheap
- `"inherit"`: Use parent process's model

### Available Tools
Common tools across demos:
- **File Operations**: Read, Write, Edit, MultiEdit, NotebookEdit
- **Search**: Glob, Grep, WebSearch, WebFetch
- **Execution**: Bash, Task (for spawning subagents)
- **Utilities**: TodoWrite, BashOutput, KillBash
- **Planning**: ExitPlanMode

Restrict via `allowedTools` array based on security needs.

## Environment Variables

### Global Requirements
- `ANTHROPIC_API_KEY`: Required for all demos

### email-agent Specific
- `EMAIL_USER`: Email address
- `EMAIL_PASSWORD`: App password (not regular password)
- `IMAP_HOST`: Email provider's IMAP server
- `IMAP_PORT`: Usually 993 for IMAP+TLS

See `.env.example` files in each demo for specifics.

## Important Implementation Notes

### Directory Structure
- Agent working directories must exist before spawning (enforced by SDK)
- Use `path.join(process.cwd(), 'agent')` pattern for relative paths
- Subagents typically work in `agent/` subdirectory

### Testing
- **email-agent**: Uses Jest with ts-jest preset, tests node environment
- **excel-demo**: Uses Jest with jsdom environment, React component testing
- Both use TypeScript for test files

### Build Artifacts
- **email-agent**: Outputs to `dist/` directory
- **excel-demo**: Outputs to `release/build/` directory (electron-builder)
- **research-agent**: Creates `files/research_notes/` and `files/reports/` at runtime

### Known Issues and Workarounds

**hello-world**:
- "Failed to spawn Claude Code process": Ensure `executable` is set to `"node"`
- "ENOENT" errors: Verify `cwd` directory exists before running

**email-agent**:
- Bun-specific: All npm commands should use `bun` instead
- Database: Migrations in `database/migrations/`

**excel-demo**:
- PostInstall runs: `npm run build:dll` - may take time on first install
- Python examples require separate venv setup in `agent/` directory

## Deployment Notes

⚠️ **None of these demos should be deployed to production.** They are designed for:
- Local development and testing
- Educational purposes
- Demonstrating SDK capabilities

Production considerations would include:
- Proper credential management (not environment variables)
- Authentication and multi-user support
- Error handling and logging
- Rate limiting
- Security hardening
