# Repo-level maintenance. Each demo still builds and runs from its own
# directory with its own package manager; these recipes only keep the Claude
# toolchain current across the demos listed below. The other demos stay on
# whatever upstream pins (see CLAUDE.md) until someone works on them; add a
# demo to a list once it has been upgraded and run.

py_demos := "research-agent"
ts_demos := "resume-generator"

# List available recipes
default:
    @just --list

# Update the Claude Code CLI and every maintained demo's Agent SDK (and with it the bundled CLI), then verify
update-claude: update-cli upgrade-sdk preflight

# Update the globally installed Claude Code CLI
update-cli:
    claude update

# Upgrade the Agent SDK in each maintained demo. The lockfiles are gitignored, so the committed record is the version floor.
upgrade-sdk:
    #!/usr/bin/env bash
    set -euo pipefail
    for d in {{ py_demos }}; do
        echo "━━━ $d (uv) ━━━"
        ( cd "$d" && uv lock --upgrade-package claude-agent-sdk && uv sync )
    done
    for d in {{ ts_demos }}; do
        echo "━━━ $d (npm) ━━━"
        ( cd "$d" && npm install @anthropic-ai/claude-agent-sdk@latest )
    done

# Report CLI / SDK / bundled-CLI versions, flag drift, and type-check the TS demos
preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "━━━ PRE-FLIGHT CHECK ━━━"
    cli=$(claude --version 2>/dev/null | grep -oP '^[\d.]+' || echo "missing")
    echo "  Installed CLI:  ${cli}"
    status=0

    # The SDK ships its own CLI binary; flag it when its major.minor drifts
    # from the installed CLI, the same check morning_report's preflight makes.
    check_bundle() {
        local demo=$1 sdk=$2 bundled=$3
        printf '  %-18s SDK %-10s bundled CLI %s\n' "$demo" "$sdk" "$bundled"
        if [[ "$bundled" == none || "$bundled" == unknown ]]; then
            echo "    ✗ no bundled CLI found"; status=1
        elif [[ "${bundled%.*}" != "${cli%.*}" ]]; then
            echo "    ✗ bundled ${bundled%.*} != installed ${cli%.*} — run: just upgrade-sdk"; status=1
        fi
    }

    py_versions='
    import importlib.metadata, subprocess
    from pathlib import Path
    import claude_agent_sdk
    p = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
    b = subprocess.check_output([str(p), "--version"], timeout=10).decode().split()[0] if p.exists() else "none"
    print(importlib.metadata.version("claude-agent-sdk"), b)
    '
    for d in {{ py_demos }}; do
        read -r sdk bundled < <(cd "$d" && uv run --no-sync python -c "$py_versions" 2>/dev/null || echo "unknown unknown")
        check_bundle "$d" "$sdk" "$bundled"
    done

    for d in {{ ts_demos }}; do
        sdk=$(node -p "require('./$d/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "unknown")
        bin=$(ls "$d"/node_modules/@anthropic-ai/claude-agent-sdk-*/claude 2>/dev/null | head -1 || true)
        bundled=$([[ -n "$bin" ]] && "$bin" --version 2>/dev/null | grep -oP '^[\d.]+' || echo "none")
        check_bundle "$d" "$sdk" "$bundled"
        if ( cd "$d" && ./node_modules/.bin/tsc --noEmit --strict --target es2022 --module nodenext \
                --moduleResolution nodenext --skipLibCheck ./*.ts ); then
            echo "    ✓ type-check clean"
        else
            echo "    ✗ type-check failed"; status=1
        fi
    done

    if [[ $status -eq 0 ]]; then echo "━━━ ✓ all checks passed ━━━"; else echo "━━━ ✗ pre-flight failed ━━━"; fi
    exit $status
