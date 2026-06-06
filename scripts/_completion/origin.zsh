#compdef origin origin-backup origin-calendar origin-contacts origin-cookbook origin-docs origin-gallery origin-mail origin-mcp origin-memory origin-notes origin-personal origin-preset origin-research origin-sessions origin-signature origin-skills origin-tasks origin-theme origin-webhook
# Zsh tab-completion for the origin umbrella + sub-CLIs.
#
# Drop in any directory on $fpath, e.g.:
#     fpath=(/path/to/origin-ui/scripts/_completion $fpath)
#     autoload -U compinit; compinit
#
# Then `origin <tab>` completes subcommands; `origin mail <tab>`
# completes mail subcommands; `origin-mail <tab>` works the same.

_origin_scripts_dir() {
    local self="${(%):-%x}"
    while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
    cd "${self:h}/.." && pwd
}

typeset -gA _origin_subs

_origin_refresh() {
    _origin_subs=()
    local dir="$(_origin_scripts_dir)"
    local py="$dir/../venv/bin/python"
    [[ -x "$py" ]] || py="$(command -v python3)"
    local f sub help_out commands
    for f in "$dir"/origin-*; do
        [[ -x "$f" ]] || continue
        case "$f" in
            *.bak|*.pyc|*.pre-*) continue ;;
        esac
        sub="${${f:t}#origin-}"
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _origin_subs[$sub]="$commands"
    done
}

_origin() {
    [[ ${#_origin_subs} -eq 0 ]] && _origin_refresh

    local cmd="${words[1]}"

    if [[ "$cmd" == "origin" ]]; then
        if (( CURRENT == 2 )); then
            local -a subs=(${(k)_origin_subs} help)
            _describe 'subcommand' subs
            return
        fi
        local sub="${words[2]}"
        if [[ "$sub" == "help" ]] && (( CURRENT == 3 )); then
            local -a subs=(${(k)_origin_subs})
            _describe 'subcommand' subs
            return
        fi
        if (( CURRENT == 3 )); then
            local -a sc=(${(s/ /)_origin_subs[$sub]})
            _describe 'command' sc
            return
        fi
        return
    fi

    # origin-foo <tab>
    local sub="${cmd#origin-}"
    if (( CURRENT == 2 )); then
        local -a sc=(${(s/ /)_origin_subs[$sub]})
        _describe 'command' sc
        return
    fi
}

_origin "$@"
