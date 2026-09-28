# Thyra shell integration. Original implementation, MIT license.
[[ $- == *i* && -n ${HERDR_PANE_ID-} && -z ${__thyra_loaded-} ]] || return 0
__thyra_loaded=1
# Seed from the clock so seq keeps rising across `exec $SHELL` (same pid).
printf -v __thyra_seq '%(%s)T' -1 2>/dev/null || __thyra_seq=${EPOCHSECONDS:-0}
__thyra_seq=$((__thyra_seq * 1000))
__thyra_armed=0
__thyra_recorded=0
__thyra_paste=false
[[ $(bind -v 2>/dev/null) == *'enable-bracketed-paste on'* ]] && __thyra_paste=true
__thyra_dir=${XDG_RUNTIME_DIR:-/tmp/thyra-$UID}/thyra/shell
__thyra_spool=${XDG_STATE_HOME:-$HOME/.local/state}/thyra/shell-history.jsonl
__thyra_file=$__thyra_dir/${HERDR_PANE_ID//[^a-zA-Z0-9_-]/_}.json
(umask 077; command mkdir -p -- "$__thyra_dir" "${__thyra_spool%/*}"; command chmod 700 "$__thyra_dir"; : >> "$__thyra_spool"; command chmod 600 "$__thyra_spool") 2>/dev/null

__thyra_json() {
    local s=$1 i c
    s=${s//\\/\\\\}; s=${s//\"/\\\"}
    if [[ $s == *[$'\x01'-$'\x1f']* ]]; then
      for ((i=1; i<32; i++)); do
        printf -v c '\\x%02x' "$i"
        printf -v c '%b' "$c"
        printf -v REPLY '\\u%04x' "$i"
        s=${s//"$c"/$REPLY}
      done
    fi
    REPLY=\"$s\"
}
__thyra_time() {
    if [[ -n ${EPOCHREALTIME-} ]]; then REPLY=${EPOCHREALTIME/./}; REPLY=${REPLY:0:13}
    else printf -v REPLY '%(%s)T' -1 2>/dev/null || REPLY=$(command date +%s); REPLY=${REPLY}000
    fi
}
__thyra_write() {
    local state=$1 code=$2 cmd=${3-} pane cwd hist ver path now paste=$__thyra_paste
    __thyra_json "$HERDR_PANE_ID"; pane=$REPLY
    __thyra_json "$PWD"; cwd=$REPLY
    __thyra_json "${HISTFILE-}"; hist=$REPLY
    __thyra_json "$BASH_VERSION"; ver=$REPLY
    __thyra_json "$PATH"; path=$REPLY
    __thyra_json "$cmd"; cmd=$REPLY
    __thyra_time; now=$REPLY
    (umask 077
      printf '{"v":1,"pane":%s,"pid":%s,"shell":"bash","shell_version":%s,"seq":%s,"state":"%s","cwd":%s,"exit":%s,"histfile":%s,"path":%s,"bracketed_paste":%s,"ts":%s,"command":%s%s}\n' "$pane" "$$" "$ver" "$__thyra_seq" "$state" "$cwd" "$code" "$hist" "$path" "$paste" "$now" "$cmd" "${BLE_VERSION:+,\"line_editor\":\"ble\"}" > "$__thyra_file.tmp-$$" && command mv -f -- "$__thyra_file.tmp-$$" "$__thyra_file"
      if [[ $state == running && $__thyra_recorded == 1 ]]; then
        printf '{"pane":%s,"pid":%s,"seq":%s,"shell":"bash","cwd":%s,"command":%s,"start_ts":%s}\n' "$pane" "$$" "$__thyra_seq" "$cwd" "$cmd" "$now" >> "$__thyra_spool"
      elif [[ $state == prompt && $__thyra_recorded == 1 ]]; then
        printf '{"pid":%s,"seq":%s,"exit":%s,"end_ts":%s}\n' "$$" "$((__thyra_seq-1))" "$code" "$now" >> "$__thyra_spool"
      fi
    ) 2>/dev/null
}
__thyra_prompt() {
    local code=$? last=$_
    __thyra_armed=0
    __thyra_history_id=$((HISTCMD-1))
    ((__thyra_seq+=1))
    __thyra_write prompt "$code"
    __thyra_recorded=0
    return "$code"
}
__thyra_ready() { __thyra_armed=1; return "$1"; }
__thyra_preexec() {
    local cmd=$1
    __thyra_armed=0
    __thyra_recorded=0
    [[ $cmd != ' '* && -n ${HISTFILE-} && -o history ]] && __thyra_recorded=1
    __thyra_write running 0 "$cmd"
}
__thyra_debug() {
    local code=$1 cmd=$2 last=$3 entry
    __thyra_debug_status=$code
    __thyra_debug_last=$last
    [[ ${FUNCNAME[1]-} == __thyra_* || ${BASH_SUBSHELL:-0} != 0 ]] && return 0
    if [[ $__thyra_armed == 1 && $cmd != __thyra_prompt* && $cmd != __thyra_ready* ]]; then
        __thyra_armed=0
        entry=$(HISTTIMEFORMAT= builtin history 1)
        if [[ $entry =~ ^[[:space:]]*([0-9]+)[[:space:]](.*)$ && ${BASH_REMATCH[1]} != "${__thyra_history_id-}" ]]; then
            __thyra_history_id=${BASH_REMATCH[1]}
            cmd=${BASH_REMATCH[2]# }
            __thyra_preexec "$cmd"
        else
            # ignorespace/history-off: never spool a stale history entry.
            __thyra_recorded=0
            __thyra_write running "$code" "$cmd"
        fi
    fi
    # Bash restores $? after DEBUG. Returning a failure here would skip the
    # user's command when extdebug is enabled.
    return 0
}
if [[ ${BLE_VERSION-} ]]; then
    # ble.sh owns PROMPT_COMMAND and the DEBUG trap; it restores $? for
    # PRECMD hooks and passes the command line to PREEXEC hooks.
    blehook PRECMD!=__thyra_prompt
    blehook PREEXEC!=__thyra_preexec
    # ble.sh skips PRECMD for the first prompt after attaching; this file is
    # sourced last in the rc, so the shell is about to show that prompt.
    __thyra_prompt
elif declare -p preexec_functions precmd_functions >/dev/null 2>&1; then
    preexec_functions+=(__thyra_preexec)
    precmd_functions+=(__thyra_prompt)
else
    # Preserve the existing DEBUG handler verbatim, including its quoting.
    __thyra_old_debug=$(trap -p DEBUG)
    if [[ -n $__thyra_old_debug ]]; then
        __thyra_old_debug=${__thyra_old_debug#trap -- }
        __thyra_old_debug=${__thyra_old_debug% DEBUG}
        eval "__thyra_old_debug=$__thyra_old_debug"
    fi
    if [[ -n $__thyra_old_debug ]]; then
        __thyra_restore() { return "$1"; }
        trap '__thyra_debug "$?" "$BASH_COMMAND" "$_"; __thyra_restore "$__thyra_debug_status" "$__thyra_debug_last"; eval "$__thyra_old_debug"; __thyra_restore "$?" "$__thyra_debug_last"' DEBUG
    else
        trap '__thyra_debug "$?" "$BASH_COMMAND" "$_"' DEBUG
    fi
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
        PROMPT_COMMAND=(__thyra_prompt "${PROMPT_COMMAND[@]}" '__thyra_ready "$?" "$_"')
    else
        PROMPT_COMMAND="__thyra_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __thyra_ready \"\$?\" \"\$_\""
    fi
fi
