"""Entry point for research agent using AgentDefinition for subagents."""

import asyncio
import dataclasses
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from claude_agent_sdk import (
    TERMINAL_TASK_STATUSES,
    AgentDefinition,
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    ResultMessage,
    TaskNotificationMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
)
from dotenv import load_dotenv

from research_agent.utils.message_handler import process_assistant_message
from research_agent.utils.subagent_tracker import SubagentTracker
from research_agent.utils.transcript import TranscriptWriter, setup_session

# Load environment variables
load_dotenv()

# Paths to prompt files
PROMPTS_DIR = Path(__file__).parent / "prompts"

# Command that renders files/reports/report.json as the themed HTML report.
# Filled into the report-writer prompt after run scoping, so the absolute
# path is never rewritten as a files/ path.
HTML_RENDERER = f"{sys.executable} {Path(__file__).parent / 'html_report.py'}"


def claude_login_active() -> bool:
    """True if the Claude Code CLI reports a login the SDK can fall back to."""
    claude = shutil.which("claude")
    if not claude:
        return False
    try:
        out = subprocess.run([claude, "auth", "status"], capture_output=True, text=True, timeout=15, check=False)
        return bool(json.loads(out.stdout).get("loggedIn"))
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return False


def load_prompt(filename: str) -> str:
    """Load a prompt from the prompts directory, headed with today's date.

    Without the date, agents cannot tell a reported result from a projection
    and have presented "final" totals for periods that had not ended.
    """
    prompt_path = PROMPTS_DIR / filename
    with open(prompt_path, "r", encoding="utf-8") as f:
        body = f.read().strip()
    return f"Today's date is {datetime.now().astimezone().date().isoformat()}.\n\n{body}"


# Output subfolders every run gets, under its own folder in files/.
RUN_SUBDIRS = ("research_notes", "fact_check", "data", "charts", "reports")


def setup_run_dir(session_dir: Path) -> Path:
    """Create this run's output folder, files/<session timestamp>/, with its subfolders.

    With one shared files/ folder, notes, charts and fact sheets from earlier
    runs sat beside the new ones, and agents read and embedded them in a
    report on an unrelated topic.
    """
    run_dir = Path("files") / session_dir.name.removeprefix("session_")
    for sub in RUN_SUBDIRS:
        (run_dir / sub).mkdir(parents=True, exist_ok=True)
    return run_dir


def scope_to_run(text: str, run_dir: Path) -> str:
    """Point every files/... path in a prompt or description at this run's folder."""
    return re.sub(r"\bfiles/", f"{run_dir.as_posix()}/", text)


def run_dir_section(run_dir: Path) -> str:
    """Lead-prompt section naming this run's output folder."""
    return (
        "<output_folder>\n"
        f"Every file this run writes or reads goes under {run_dir.as_posix()}/. Wherever any "
        f"instruction, including a slash command, says files/, use {run_dir.as_posix()}/ instead, "
        "and pass that folder to every subagent you spawn. Never read or reuse other folders in files/.\n"
        "</output_folder>"
    )


def prior_studies_dirs() -> list[Path]:
    """Directories named in PRIOR_STUDIES_DIRS (os.pathsep-separated) that exist.

    The lookup searches only these. Left to infer a location, the lead picked
    the first project path it saw in the user's CLAUDE.md, which was the wrong
    repository, and reported that no prior studies existed.
    """
    raw = os.environ.get("PRIOR_STUDIES_DIRS", "")
    dirs = [Path(p).expanduser().resolve() for p in raw.split(os.pathsep) if p.strip()]
    for d in dirs:
        if not d.is_dir():
            print(f"Warning: PRIOR_STUDIES_DIRS entry is not a directory, skipped: {d}")
    return [d for d in dirs if d.is_dir()]


def prior_studies_section(dirs: list[Path]) -> str:
    """Lead-prompt section saying where prior studies live, or that none are configured."""
    if not dirs:
        return (
            "<prior_studies>\n"
            "No prior-studies location is configured. Do NOT search the local filesystem for "
            "prior studies or the user's projects; research the web only.\n"
            "</prior_studies>"
        )
    listed = "\n".join(f"- {d}" for d in dirs)
    return (
        "<prior_studies>\n"
        "The user's own prior studies live ONLY in these directories:\n"
        f"{listed}\n"
        "When the topic concerns the user's own system or data, spawn ONE prior-studies subagent "
        "in STEP 2, in parallel with the researchers, and pass it these directories verbatim. "
        "Never search the local filesystem any other way, and never point a subagent at a "
        "directory not listed here.\n"
        "</prior_studies>"
    )


# How long to keep listening after the last background task finishes, for the
# lead's follow-up turn to start.
IDLE_GRACE_SECONDS = 10


async def stream_until_idle(client, tracker, transcript):
    """Stream messages until the lead and every subagent it launched are done.

    Subagents run as background tasks: the lead's turn ends right after it
    spawns them, and each result comes back as a turn the session injects
    later. Reading only to the first ResultMessage would drop the rest of the
    pipeline, so keep reading until no tasks are active and nothing new
    arrives for IDLE_GRACE_SECONDS.
    """
    active: set[str] = set()
    idle = False
    messages = client.receive_messages().__aiter__()
    while True:
        try:
            if idle:
                msg = await asyncio.wait_for(messages.__anext__(), IDLE_GRACE_SECONDS)
            else:
                msg = await messages.__anext__()
        except (StopAsyncIteration, TimeoutError):
            return

        if isinstance(msg, AssistantMessage):
            process_assistant_message(msg, tracker, transcript)
        elif isinstance(msg, TaskStartedMessage):
            active.add(msg.task_id)
            tracker.register_task(msg.task_id, msg.tool_use_id)
        elif isinstance(msg, TaskNotificationMessage) or (
            isinstance(msg, TaskUpdatedMessage) and msg.status in TERMINAL_TASK_STATUSES
        ):
            active.discard(msg.task_id)

        idle = isinstance(msg, ResultMessage) and not active


async def chat():
    """Start interactive chat with the research agent."""

    # Check credentials first, before creating any files. Without an API key
    # the SDK falls back to the Claude Code CLI login.
    if os.environ.get("ANTHROPIC_API_KEY"):
        print("\nAuth: ANTHROPIC_API_KEY")
    elif claude_login_active():
        print("\nAuth: Claude Code login (no ANTHROPIC_API_KEY set)")
    else:
        print("\nError: no credentials found.")
        print("Set ANTHROPIC_API_KEY in a .env file or your shell, or log in with `claude auth login`.")
        print("Get a key at: https://console.anthropic.com/settings/keys\n")
        return

    # Setup session directory and transcript
    transcript_file, session_dir = setup_session()
    run_dir = setup_run_dir(session_dir)

    # Create transcript writer
    transcript = TranscriptWriter(transcript_file)

    # Load prompts
    studies_dirs = prior_studies_dirs()
    # Scope the prompt file only: the run-folder section already names the run
    # folder, and scoping it again nested the output (files/RUN/RUN/).
    lead_agent_prompt = (
        f"{scope_to_run(load_prompt('lead_agent.txt'), run_dir)}\n\n"
        f"{run_dir_section(run_dir)}\n\n{prior_studies_section(studies_dirs)}"
    )
    researcher_prompt = load_prompt("researcher.txt")
    fact_checker_prompt = load_prompt("fact_checker.txt")
    data_analyst_prompt = load_prompt("data_analyst.txt")
    report_writer_prompt = load_prompt("report_writer.txt")

    # Initialize subagent tracker with transcript writer and session directory
    tracker = SubagentTracker(transcript_writer=transcript, session_dir=session_dir)

    # Define specialized subagents
    agents = {
        "researcher": AgentDefinition(
            description=(
                "Use this agent when you need to gather research information on any topic. "
                "The researcher uses web search to find relevant information, articles, and sources "
                "from across the internet. Writes research findings to files/research_notes/ "
                "for later use by report writers. Ideal for complex research tasks "
                "that require deep searching and cross-referencing."
            ),
            tools=["WebSearch", "Write"],
            prompt=researcher_prompt,
            model="haiku"
        ),
        "fact-checker": AgentDefinition(
            description=(
                "Use this agent AFTER all researchers finish and BEFORE the data-analyst. "
                "The fact-checker reads every note in files/research_notes/, cross-checks the notes "
                "against each other, re-fetches cited sources to confirm each key figure, recomputes "
                "derived numbers, and writes files/fact_check/verified_facts.md and files/fact_check/ledger.md. "
                "Downstream agents may use only facts it marks CONFIRMED or CORRECTED."
            ),
            tools=["Glob", "Read", "WebFetch", "WebSearch", "Bash", "Write"],
            prompt=fact_checker_prompt,
            model="sonnet"
        ),
        "data-analyst": AgentDefinition(
            description=(
                "Use this agent AFTER the fact-checker has finished to generate quantitative "
                "analysis and visualizations. The data-analyst reads files/fact_check/verified_facts.md, "
                "extracts numerical data (percentages, rankings, trends, comparisons), and generates "
                "charts using Python/matplotlib via Bash. Saves charts to files/charts/ and writes "
                "a data summary to files/data/. Use this before the report-writer to add visual insights."
            ),
            tools=["Glob", "Read", "Bash", "Write"],
            prompt=data_analyst_prompt,
            model="haiku"
        ),
        "report-writer": AgentDefinition(
            description=(
                "Use this agent when you need to create a formal research report document. "
                "The report-writer reads verified facts from files/fact_check/, research findings from files/research_notes/, data analysis "
                "from files/data/, and charts from files/charts/, then synthesizes them into clear, "
                "concise, professionally formatted reports in files/reports/: a PDF built with reportlab and "
                "a matching HTML page (dark theme with a light toggle, interactive charts), both from one "
                "report.json. Ideal for creating structured documents with proper citations, data, and embedded "
                "visuals. Does NOT conduct web searches - only reads existing research notes and writes reports."
            ),
            tools=["Skill", "Write", "Glob", "Read", "Bash"],
            prompt=report_writer_prompt,
            model="haiku"
        )
    }

    if studies_dirs:
        listed = "\n".join(f"- {d}" for d in studies_dirs)
        agents["prior-studies"] = AgentDefinition(
            description=(
                "Use this agent, in parallel with the researchers, when the topic concerns the "
                "user's own system or data. It searches ONLY the configured prior-studies "
                "directories for the user's measured results and standing constraints, and writes "
                "files/research_notes/prior_studies.md for the fact-checker and report-writer."
            ),
            tools=["Glob", "Grep", "Read", "Write"],
            prompt=f"{load_prompt('prior_studies.txt')}\n\n<prior_studies_dirs>\n{listed}\n</prior_studies_dirs>",
            model="sonnet"
        )

    agents = {
        name: dataclasses.replace(
            agent,
            description=scope_to_run(agent.description, run_dir),
            prompt=scope_to_run(agent.prompt, run_dir).replace("{HTML_RENDERER}", HTML_RENDERER),
        )
        for name, agent in agents.items()
    }

    # Set up hooks for tracking
    hooks = {
        'PreToolUse': [
            HookMatcher(
                matcher=None,  # Match all tools
                hooks=[tracker.pre_tool_use_hook]
            )
        ],
        'PostToolUse': [
            HookMatcher(
                matcher=None,  # Match all tools
                hooks=[tracker.post_tool_use_hook]
            )
        ]
    }

    options = ClaudeAgentOptions(
        permission_mode="bypassPermissions",
        setting_sources=["project"],  # Load skills from project .claude directory
        system_prompt=lead_agent_prompt,
        allowed_tools=["Task"],
        agents=agents,
        hooks=hooks,
        model="haiku",
        # The CLI also loads .claude/CLAUDE.md from every folder above cwd, so the
        # user's own instructions for unrelated work steered the research (one run
        # went looking for "prior studies" in a project the topic never named).
        # The prompts above are the agent's only instructions.
        env={"CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1"},
    )

    print("\n" + "=" * 50)
    print("  Research Agent")
    print("=" * 50)
    print("\nResearch any topic and get a comprehensive PDF")
    print("and HTML report with data visualizations.")
    print("\nType 'exit' to quit.\n")

    try:
        async with ClaudeSDKClient(options=options) as client:
            while True:
                # Get input
                try:
                    user_input = input("\nYou: ").strip()
                except (EOFError, KeyboardInterrupt):
                    break

                if not user_input or user_input.lower() in ["exit", "quit", "q"]:
                    break

                # Write user input to transcript (file only, not console)
                transcript.write_to_file(f"\nYou: {user_input}\n")

                # Send to agent
                await client.query(prompt=user_input)

                transcript.write("\nAgent: ", end="")

                # Stream and process response, including subagent follow-ups
                await stream_until_idle(client, tracker, transcript)

                transcript.write("\n")
    finally:
        transcript.write("\n\nGoodbye!\n")
        transcript.close()
        tracker.close()
        print(f"\nRun output saved to: {run_dir}")
        print(f"Session logs saved to: {session_dir}")
        print(f"  - Transcript: {transcript_file}")
        print(f"  - Tool calls: {session_dir / 'tool_calls.jsonl'}")


if __name__ == "__main__":
    asyncio.run(chat())
