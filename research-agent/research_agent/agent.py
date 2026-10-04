"""Entry point for research agent using AgentDefinition for subagents."""

import asyncio
import json
import os
import shutil
import subprocess
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
    """Load a prompt from the prompts directory."""
    prompt_path = PROMPTS_DIR / filename
    with open(prompt_path, "r", encoding="utf-8") as f:
        return f.read().strip()


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

    # Create transcript writer
    transcript = TranscriptWriter(transcript_file)

    # Load prompts
    lead_agent_prompt = load_prompt("lead_agent.txt")
    researcher_prompt = load_prompt("researcher.txt")
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
        "data-analyst": AgentDefinition(
            description=(
                "Use this agent AFTER researchers have completed their work to generate quantitative "
                "analysis and visualizations. The data-analyst reads research notes from files/research_notes/, "
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
                "The report-writer reads research findings from files/research_notes/, data analysis "
                "from files/data/, and charts from files/charts/, then synthesizes them into clear, "
                "concise, professionally formatted PDF reports in files/reports/ using reportlab. "
                "Ideal for creating structured documents with proper citations, data, and embedded visuals. "
                "Does NOT conduct web searches - only reads existing research notes and creates PDF reports."
            ),
            tools=["Skill", "Write", "Glob", "Read", "Bash"],
            prompt=report_writer_prompt,
            model="haiku"
        )
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
        model="haiku"
    )

    print("\n" + "=" * 50)
    print("  Research Agent")
    print("=" * 50)
    print("\nResearch any topic and get a comprehensive PDF")
    print("report with data visualizations.")
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
        print(f"\nSession logs saved to: {session_dir}")
        print(f"  - Transcript: {transcript_file}")
        print(f"  - Tool calls: {session_dir / 'tool_calls.jsonl'}")


if __name__ == "__main__":
    asyncio.run(chat())
