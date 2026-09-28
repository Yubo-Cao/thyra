# Thyra shell integration. Original implementation, MIT license.
[[ -o interactive && -n ${HERDR_PANE_ID-} && -z ${__thyra_loaded-} ]] || return 0
typeset -g __thyra_loaded=1 __thyra_seq=0 __thyra_recorded=0
typeset -g __thyra_dir=${XDG_RUNTIME_DIR:-/tmp/thyra-$UID}/thyra/shell
typeset -g __thyra_spool=${XDG_STATE_HOME:-$HOME/.local/state}/thyra/shell-history.jsonl
typeset -g __thyra_file=$__thyra_dir/${HERDR_PANE_ID//[^a-zA-Z0-9_-]/_}.json
(umask 077; command mkdir -p -- "$__thyra_dir" "${__thyra_spool%/*}"; command chmod 700 "$__thyra_dir"; : >> "$__thyra_spool"; command chmod 600 "$__thyra_spool") 2>/dev/null
zmodload zsh/datetime 2>/dev/null
__thyra_json() {
    emulate -L zsh
    local s=$1 c escaped
    integer i
    s=${s//\\/\\\\}; s=${s//\"/\\\"}
    for ((i=1; i<32; i++)); do
        printf -v c '\\x%02x' $i
        printf -v c '%b' "$c"
        printf -v escaped '\\u%04x' $i
        s=${s//"$c"/$escaped}
    done
    REPLY=\"$s\"
}
__thyra_write() {
    emulate -L zsh
    local state=$1 code=$2 cmd=${3-} pane cwd hist ver shell_path now paste=false
    __thyra_json "$HERDR_PANE_ID"; pane=$REPLY
    __thyra_json "$PWD"; cwd=$REPLY
    __thyra_json "${HISTFILE-}"; hist=$REPLY
    __thyra_json "$ZSH_VERSION"; ver=$REPLY
    __thyra_json "$PATH"; shell_path=$REPLY
    __thyra_json "$cmd"; cmd=$REPLY
    printf -v now '%.0f' "$((EPOCHREALTIME * 1000))"
    (( ${#zle_bracketed_paste} )) && paste=true
    (umask 077
      printf '{"v":1,"pane":%s,"pid":%s,"shell":"zsh","shell_version":%s,"seq":%s,"state":"%s","cwd":%s,"exit":%s,"histfile":%s,"path":%s,"bracketed_paste":%s,"ts":%s,"command":%s}\n' "$pane" "$$" "$ver" "$__thyra_seq" "$state" "$cwd" "$code" "$hist" "$shell_path" "$paste" "$now" "$cmd" > "$__thyra_file.tmp-$$" && command mv -f -- "$__thyra_file.tmp-$$" "$__thyra_file"
      if [[ $state == running && $__thyra_recorded == 1 ]]; then
        printf '{"pane":%s,"pid":%s,"seq":%s,"shell":"zsh","cwd":%s,"command":%s,"start_ts":%s}\n' "$pane" "$$" "$__thyra_seq" "$cwd" "$cmd" "$now" >> "$__thyra_spool"
      elif [[ $state == prompt && $__thyra_recorded == 1 ]]; then
        printf '{"pid":%s,"seq":%s,"exit":%s,"end_ts":%s}\n' "$$" "$((__thyra_seq-1))" "$code" "$now" >> "$__thyra_spool"
      fi
    ) 2>/dev/null
}
__thyra_precmd() {
    local code=$?
    ((__thyra_seq+=1))
    __thyra_write prompt "$code"
    __thyra_recorded=0
    # zsh preserves the command status around hooks; nonzero would prevent
    # subsequently registered precmd hooks from running.
    return 0
}
__thyra_preexec() {
    __thyra_recorded=0
    [[ $1 != ' '* && -n ${HISTFILE-} && $HISTSIZE -gt 0 ]] && __thyra_recorded=1
    __thyra_write running 0 "$1"
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __thyra_precmd
add-zsh-hook preexec __thyra_preexec
