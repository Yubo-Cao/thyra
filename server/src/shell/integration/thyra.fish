# Thyra shell integration. Original implementation, MIT license.
status is-interactive; or return
set -q HERDR_PANE_ID; or return
test -n "$HERDR_PANE_ID"; or return
set -q __thyra_loaded; and return
set -g __thyra_loaded 1
set -g __thyra_seq 0
set -g __thyra_recorded 0
set -l runtime /tmp/thyra-(id -u)
set -q XDG_RUNTIME_DIR; and set runtime $XDG_RUNTIME_DIR
set -l state $HOME/.local/state
set -q XDG_STATE_HOME; and set state $XDG_STATE_HOME
set -g __thyra_dir $runtime/thyra/shell
set -g __thyra_spool $state/thyra/shell-history.jsonl
set -g __thyra_file $__thyra_dir/(string replace -ar '[^a-zA-Z0-9_-]' _ -- $HERDR_PANE_ID).json
begin
    set -l old_umask (umask)
    umask 077
    command mkdir -p -- $__thyra_dir $state/thyra
    command chmod 700 $__thyra_dir
    printf '' >> $__thyra_spool
    command chmod 600 $__thyra_spool
    umask $old_umask
end 2>/dev/null
function __thyra_json
    # A sentinel prevents command substitution from trimming input newlines.
    set -l value (string replace -a '\\' '\\\\' -- "$argv[1]x" | string collect)
    set value (string replace -a '"' '\\"' -- "$value" | string collect)
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
        set -l c (printf '%b' (printf '\\x%02x' $i) | string collect -N -a)
        set -l escaped (printf '\\u%04x' $i)
        set value (string replace -a -- "$c" "$escaped" "$value" | string collect)
    end
    printf '"%s"' (string replace -r 'x$' '' -- "$value" | string collect -a)
end
function __thyra_write
    set -l phase $argv[1]
    set -l code $argv[2]
    set -l cmd "$argv[3]"
    set -l now (date +%s)000
    set -l hist $HOME/.local/share/fish/fish_history
    set -q XDG_DATA_HOME; and set hist $XDG_DATA_HOME/fish/fish_history
    set -q fish_history; and set hist (path dirname $hist)/{$fish_history}_history
    set -l old_umask (umask)
    umask 077
    printf '{"v":1,"pane":%s,"pid":%s,"shell":"fish","shell_version":%s,"seq":%s,"state":"%s","cwd":%s,"exit":%s,"histfile":%s,"path":%s,"bracketed_paste":true,"ts":%s,"command":%s}\n' (__thyra_json "$HERDR_PANE_ID") $fish_pid (__thyra_json "$version") $__thyra_seq $phase (__thyra_json "$PWD") $code (__thyra_json "$hist") (__thyra_json (string join : $PATH)) $now (__thyra_json "$cmd") > $__thyra_file.tmp-$fish_pid
    and command mv -f -- $__thyra_file.tmp-$fish_pid $__thyra_file
    if test $phase = running; and test $__thyra_recorded = 1
        printf '{"pane":%s,"pid":%s,"seq":%s,"shell":"fish","cwd":%s,"command":%s,"start_ts":%s}\n' (__thyra_json "$HERDR_PANE_ID") $fish_pid $__thyra_seq (__thyra_json "$PWD") (__thyra_json "$cmd") $now >> $__thyra_spool
    else if test $phase = prompt; and test $__thyra_recorded = 1
        printf '{"pid":%s,"seq":%s,"exit":%s,"end_ts":%s}\n' $fish_pid (math $__thyra_seq - 1) $code $now >> $__thyra_spool
    end
    umask $old_umask
end
function __thyra_prompt --on-event fish_prompt
    set -l code $status
    set -g __thyra_seq (math $__thyra_seq + 1)
    __thyra_write prompt $code '' 2>/dev/null
    set -g __thyra_recorded 0
    return $code
end
function __thyra_preexec --on-event fish_preexec
    set -g __thyra_recorded 0
    if not string match -q ' *' -- "$argv[1]"
        if not set -q fish_history; or test -n "$fish_history"
            set -g __thyra_recorded 1
        end
    end
    __thyra_write running 0 "$argv[1]" 2>/dev/null
end
