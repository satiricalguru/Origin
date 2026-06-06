#!/usr/bin/env bash
# Tab-completion for the `origin` umbrella + every `origin-*` CLI.
#
# Source from your shell rc:
#     source /path/to/origin-ui/scripts/_completion/origin.bash
#
# Or wire it once per machine:
#     sudo install -m 644 origin.bash /etc/bash_completion.d/origin
#
# What it does:
#   - On the first word after `origin`, complete with the list of
#     subcommands (`mail`, `calendar`, ...).
#   - On subsequent words, complete with the subcommand's first-token
#     subcommands (`list`, `show`, ...) which we cache by parsing the
#     tool's own --help output. Updates lazily; refresh by running
#     `_origin_refresh_cache`.
#   - Same completion works for the individual `origin-foo` scripts.

_origin_scripts_dir() {
    # Resolve the scripts/ dir from the script that sources us. We assume
    # the user sourced the file directly out of scripts/_completion/.
    local self="${BASH_SOURCE[0]}"
    while [ -L "$self" ]; do self=$(readlink "$self"); done
    cd "$(dirname "$self")/.." && pwd
}

declare -A _ORIGIN_SUBS_CACHE=()

_origin_refresh_cache() {
    local dir="$(_origin_scripts_dir)"
    _ORIGIN_SUBS_CACHE=()
    # Prefer the project venv's Python so deps (bcrypt, sqlalchemy, ...)
    # resolve. Falls back to system `python3` for container installs.
    local py="$dir/../venv/bin/python"
    [ -x "$py" ] || py="$(command -v python3)"
    local f
    for f in "$dir"/origin-*; do
        [ -x "$f" ] || continue
        case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
        local name="$(basename "$f")"
        local sub="${name#origin-}"
        local help_out
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        local commands
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _ORIGIN_SUBS_CACHE[$sub]="$commands"
    done
}

_origin_complete() {
    [ ${#_ORIGIN_SUBS_CACHE[@]} -eq 0 ] && _origin_refresh_cache

    local cur="${COMP_WORDS[COMP_CWORD]}"
    local cmd="${COMP_WORDS[0]}"

    # `origin <tab>` → list every subcommand
    if [ "$cmd" = "origin" ]; then
        if [ "$COMP_CWORD" -eq 1 ]; then
            local subs="${!_ORIGIN_SUBS_CACHE[@]} help"
            COMPREPLY=($(compgen -W "$subs" -- "$cur"))
            return 0
        fi
        # `origin foo <tab>` — complete with foo's own subcommands
        local sub="${COMP_WORDS[1]}"
        # `origin help <tab>` lists every subcommand
        if [ "$sub" = "help" ] && [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${!_ORIGIN_SUBS_CACHE[*]}" -- "$cur"))
            return 0
        fi
        if [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${_ORIGIN_SUBS_CACHE[$sub]}" -- "$cur"))
            return 0
        fi
        return 0
    fi

    # Direct `origin-foo <tab>` (no umbrella)
    local sub="${cmd#origin-}"
    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=($(compgen -W "${_ORIGIN_SUBS_CACHE[$sub]}" -- "$cur"))
        return 0
    fi
}

# Register the completion for every origin-* script + the umbrella.
complete -F _origin_complete origin
for f in "$(_origin_scripts_dir)"/origin-*; do
    [ -x "$f" ] || continue
    case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
    complete -F _origin_complete "$(basename "$f")"
done
