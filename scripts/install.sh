#!/bin/sh
# shellcheck disable=SC2015 # "check && check || fail" guards are intended; fail exits.
# Thyra installer for Linux and macOS.
#
#   curl -fsSL https://github.com/Yubo-Cao/thyra/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --uninstall
#
# Installs Thyra and the Herdr build pinned by that Thyra release into
# ~/.local/bin (no sudo), verifies SHA-256 checksums, and starts both as user
# services (systemd on Linux, launchd on macOS). Re-running upgrades in place.
# Run with --help for options.
set -eu

github_repository="Yubo-Cao/thyra"

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Thyra installer: warning: %s\n' "$*" >&2
}

fail() {
  printf 'Thyra installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install, upgrade, or remove Thyra and its Herdr server.

Usage: install.sh [options]
       curl -fsSL <url>/install.sh | sh -s -- [options]

Options:
  --version X.Y.Z   Install this Thyra release instead of the latest one.
  --port N          Thyra's port for a new service config (default 8787).
  --lan             Listen on all interfaces; browsers log in with passkeys.
  --local           Listen on 127.0.0.1 only (the default for new configs).
  --no-service      Install binaries only; do not create or start services.
  --no-herdr        Do not install or start Herdr.
  --replace-herdr   Replace a Herdr binary this installer did not install.
  --uninstall       Stop and remove the services and installed binaries.
  --purge           With --uninstall, also delete ~/.config/thyra (accounts,
                    connection profiles, settings). Herdr data is never removed.
  -h, --help        Show this help.

Environment:
  THYRA_VERSION, THYRA_PORT        Same as --version and --port.
  THYRA_INSTALL_DIR                Binary directory (default ~/.local/bin).
  THYRA_NO_SERVICE=1, THYRA_NO_HERDR=1
  THYRA_INSTALL_BASE_URL           Flat mirror of Thyra release assets.
  THYRA_HERDR_BASE_URL             Flat mirror of the pinned Herdr assets.
Mirrors must use HTTPS unless they are on loopback.
EOF
}

# ---------------------------------------------------------------------------
# Pure helpers. Tests source this file with THYRA_INSTALLER_LIBRARY=1.

# thyra_platform <uname -s> <uname -m> [rosetta 0|1]
thyra_platform() {
  case "$1:$2" in
  Darwin:arm64 | Darwin:aarch64) printf 'darwin-arm64\n' ;;
  Darwin:x86_64 | Darwin:amd64)
    # An x86_64 shell under Rosetta still runs on Apple Silicon.
    if [ "${3:-0}" = 1 ]; then
      printf 'darwin-arm64\n'
    else
      printf 'darwin-x64\n'
    fi
    ;;
  Linux:x86_64 | Linux:amd64) printf 'linux-x64\n' ;;
  Linux:arm64 | Linux:aarch64) printf 'linux-arm64\n' ;;
  *) return 1 ;;
  esac
}

# herdr_target <thyra platform>
herdr_target() {
  case "$1" in
  linux-x64) printf 'linux-x86_64\n' ;;
  linux-arm64) printf 'linux-aarch64\n' ;;
  darwin-x64) printf 'macos-x86_64\n' ;;
  darwin-arm64) printf 'macos-aarch64\n' ;;
  *) return 1 ;;
  esac
}

# release_base <custom base> <version> -> base URL without a trailing slash
release_base() {
  if [ -n "$1" ]; then
    base="$1"
  elif [ -n "$2" ]; then
    base="https://github.com/$github_repository/releases/download/v$2"
  else
    base="https://github.com/$github_repository/releases/latest/download"
  fi
  while [ "${base%/}" != "$base" ]; do
    base="${base%/}"
  done
  printf '%s\n' "$base"
}

# curl_protocol <url>: prints the curl --proto value or fails.
curl_protocol() {
  case "$1" in
  *\?* | *\#*)
    printf 'URL must not contain a query or fragment: %s\n' "$1" >&2
    return 1
    ;;
  esac
  authority="${1#*://}"
  authority="${authority%%/*}"
  case "$authority" in
  "")
    printf 'invalid URL: %s\n' "$1" >&2
    return 1
    ;;
  *@*)
    printf 'URL must not contain credentials: %s\n' "$1" >&2
    return 1
    ;;
  esac
  case "$1" in
  https://*) printf '=https\n' ;;
  http://*)
    case "$authority" in
    localhost | localhost:* | 127.0.0.1 | 127.0.0.1:* | "[::1]" | "[::1]":*)
      printf '=http\n'
      ;;
    *)
      printf 'URL must use HTTPS unless the mirror is loopback: %s\n' "$1" >&2
      return 1
      ;;
    esac
    ;;
  *)
    printf 'URL must be an HTTP(S) URL: %s\n' "$1" >&2
    return 1
    ;;
  esac
}

# checksum_from_file <file> <expected asset name> -> lowercase digest
checksum_from_file() {
  line="$(cat "$1")" || return 1
  set -f
  # shellcheck disable=SC2086 # Split "digest  name" into fields.
  set -- $line "$2"
  set +f
  [ "$#" -eq 3 ] || return 1
  [ "$2" = "$3" ] || return 1
  valid_sha256 "$1" || return 1
  printf '%s\n' "$1" | awk '{ print tolower($0) }'
}

valid_sha256() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in
  *[!0-9A-Fa-f]*) return 1 ;;
  esac
}

# pin_value <herdr-release.json> <key>: top-level string or number value.
pin_value() {
  awk -v key="$2" '
    BEGIN { pattern = "^  \"" key "\": " }
    $0 ~ pattern {
      value = $0
      sub(pattern, "", value)
      sub(/,$/, "", value)
      gsub(/"/, "", value)
      print value
      exit
    }
  ' "$1"
}

# pin_sha256 <herdr-release.json> <herdr target>
pin_sha256() {
  awk -v key="$2" '
    /^  "sha256": \{/ { inside = 1; next }
    inside && /^  \}/ { exit }
    inside {
      line = $0
      if (index(line, "\"" key "\":") == 0) next
      sub(/^[^:]*: *"/, "", line)
      sub(/".*$/, "", line)
      print tolower(line)
      exit
    }
  ' "$1"
}

# herdr_action <installed sha|-> <recorded sha|-> <pinned sha> <other herdr on PATH 0|1> <replace 0|1>
# Prints one of: current, install, upgrade, replace, keep.
herdr_action() {
  installed="$1" recorded="$2" pinned="$3" other="$4" replace="$5"
  if [ "$installed" != - ]; then
    if [ "$installed" = "$pinned" ]; then
      printf 'current\n'
    elif [ "$installed" = "$recorded" ]; then
      printf 'upgrade\n'
    elif [ "$replace" = 1 ]; then
      printf 'replace\n'
    else
      printf 'keep\n'
    fi
  elif [ "$other" = 1 ] && [ "$replace" != 1 ]; then
    printf 'keep\n'
  else
    printf 'install\n'
  fi
}

# env_value <file> <NAME>: last uncommented assignment, quotes removed.
env_value() {
  [ -f "$1" ] || return 0
  awk -v name="$2" '
    {
      line = $0
      sub(/^[ \t]*(export[ \t]+)?/, "", line)
      if (index(line, name "=") != 1) next
      value = substr(line, length(name) + 2)
      sub(/[ \t]+$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) {
        value = substr(value, 2, length(value) - 2)
      }
      found = value
    }
    END { if (found != "") print found }
  ' "$1"
}

# set_env_value <file> <NAME> <value>: replace assignments or append one.
set_env_value() {
  awk -v name="$2" -v value="$3" '
    {
      line = $0
      sub(/^[ \t]*(export[ \t]+)?/, "", line)
      if (index(line, name "=") == 1) {
        if (!done) print name "=" value
        done = 1
        next
      }
      print
    }
    END { if (!done) print name "=" value }
  ' "$1" >"$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"
}

valid_port() {
  case "$1" in
  "" | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# ---------------------------------------------------------------------------
# Effects.

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk 'NR == 1 { print $1 }'
  else
    shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
  fi
}

# fetch <url> <output> [max bytes]
fetch() {
  proto="$(curl_protocol "$1")" || return 1
  if [ -n "${3:-}" ]; then
    curl --proto "$proto" --proto-redir "$proto" --max-filesize "$3" \
      -fsSL --retry 2 --connect-timeout 20 -o "$2" "$1"
  else
    curl --proto "$proto" --proto-redir "$proto" \
      -fsSL --retry 2 --connect-timeout 20 -o "$2" "$1"
  fi
}

# install_file <source> <target>: atomic replace, previous copy kept.
install_file() {
  staged="$(mktemp "$(dirname "$2")/.$(basename "$2").new.XXXXXX")"
  staged_files="$staged_files $staged"
  install -m 0755 "$1" "$staged"
  if [ -f "$2" ] && [ ! -L "$2" ]; then
    backup_staged="$(mktemp "$(dirname "$2")/.$(basename "$2").previous.XXXXXX")"
    staged_files="$staged_files $backup_staged"
    install -m 0755 "$2" "$backup_staged"
    mv -f "$backup_staged" "$2.previous"
  fi
  mv -f "$staged" "$2"
}

require_regular_target() {
  if { [ -e "$1" ] || [ -L "$1" ]; } && { [ ! -f "$1" ] || [ -L "$1" ]; }; then
    fail "install target exists but is not a regular file: $1"
  fi
}

cleanup() {
  if [ -n "${tmp:-}" ]; then
    rm -rf "$tmp"
  fi
  for file in ${staged_files:-}; do
    rm -f "$file"
  done
}

port_in_use() {
  code=0
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" || code=$?
  [ "$code" -ne 7 ]
}

systemd_user_available() {
  command -v systemctl >/dev/null 2>&1 &&
    systemctl --user show-environment >/dev/null 2>&1
}

write_service_config() {
  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  if [ ! -f "$config_file" ]; then
    port="${requested_port:-8787}"
    host=127.0.0.1
    [ "$bind_mode" = lan ] && host=0.0.0.0
    if port_in_use "$port"; then
      fail "port $port is already in use; rerun with --port <free port>"
    fi
    umask_before="$(umask)"
    umask 077
    cat >"$config_file" <<EOF
# Thyra service environment. Created by the Thyra installer and preserved on
# upgrade; restart the service after editing (thyra service restart).
# HOST=127.0.0.1 accepts only this machine and needs no login. For phones and
# other computers, publish it privately with Tailscale Serve, or set
# HOST=0.0.0.0 and log in with passkeys (thyra user add <name> --admin).
HOST=$host
PORT=$port

# THYRA_PUBLIC_BASE_URL=https://thyra.example.com
# THYRA_TLS_CERT=/path/to/cert-chain.pem
# THYRA_TLS_KEY=/path/to/private-key.pem
# THYRA_LOG_LEVEL=info
EOF
    umask "$umask_before"
    say "Created $config_file"
    return
  fi
  if [ -n "$requested_port" ]; then
    set_env_value "$config_file" PORT "$requested_port"
  fi
  case "$bind_mode" in
  lan) set_env_value "$config_file" HOST 0.0.0.0 ;;
  local) set_env_value "$config_file" HOST 127.0.0.1 ;;
  esac
  chmod 600 "$config_file"
}

wait_for_thyra() {
  scheme=http
  [ -n "$(env_value "$config_file" THYRA_TLS_CERT)" ] && scheme=https
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if curl -fsk -o /dev/null --max-time 2 "$scheme://127.0.0.1:$1/healthz"; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

installed_herdr_record() {
  [ -f "$state_file" ] || return 0
  awk 'NR == 1 { print $1 }' "$state_file"
}

uninstall() {
  thyra="$bin_dir/thyra"
  if [ "$no_service" != 1 ]; then
    if [ -x "$thyra" ]; then
      "$thyra" service uninstall </dev/null ||
        warn "could not remove the Thyra service; see thyra service --help"
      if [ "$no_herdr" != 1 ]; then
        "$thyra" herdr uninstall </dev/null ||
          warn "could not remove the Thyra-managed Herdr service"
      fi
    else
      warn "$thyra is missing; remove any Thyra services by hand"
    fi
  fi
  rm -f "$thyra" "$thyra.previous"
  say "Removed $thyra"

  herdr="$bin_dir/herdr"
  recorded="$(installed_herdr_record)"
  if [ -n "$recorded" ] && [ -f "$herdr" ] && [ ! -L "$herdr" ] &&
    [ "$(sha256_of "$herdr")" = "$recorded" ]; then
    if [ "$no_herdr" = 1 ]; then
      say "Kept $herdr (--no-herdr)"
    else
      rm -f "$herdr" "$herdr.previous"
      say "Removed $herdr"
    fi
  elif [ -e "$herdr" ]; then
    say "Kept $herdr: this installer did not install it"
  fi
  rm -f "$state_file"

  if [ "$purge" = 1 ]; then
    rm -rf "$config_dir"
    rm -f "$HOME/Library/Logs/thyra.stdout.log" \
      "$HOME/Library/Logs/thyra.stderr.log" \
      "$HOME/Library/Logs/thyra-herdr.stdout.log" \
      "$HOME/Library/Logs/thyra-herdr.stderr.log"
    say "Removed $config_dir"
  else
    [ -d "$config_dir" ] &&
      say "Kept $config_dir (accounts, connections, settings); --purge removes it"
  fi
  say "Herdr's own data in ~/.config/herdr was not changed."
}

main() {
  requested_version="${THYRA_VERSION:-}"
  requested_port="${THYRA_PORT:-}"
  no_service="${THYRA_NO_SERVICE:-0}"
  no_herdr="${THYRA_NO_HERDR:-0}"
  replace_herdr=0
  bind_mode=""
  mode=install
  purge=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version needs a value"
      requested_version="$2"
      shift
      ;;
    --version=*) requested_version="${1#*=}" ;;
    --port)
      [ "$#" -ge 2 ] || fail "--port needs a value"
      requested_port="$2"
      shift
      ;;
    --port=*) requested_port="${1#*=}" ;;
    --lan) bind_mode=lan ;;
    --local) bind_mode=local ;;
    --no-service) no_service=1 ;;
    --no-herdr) no_herdr=1 ;;
    --replace-herdr) replace_herdr=1 ;;
    --uninstall) mode=uninstall ;;
    --purge) purge=1 ;;
    -h | --help)
      usage
      return 0
      ;;
    *) fail "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  [ "$purge" = 0 ] || [ "$mode" = uninstall ] || fail "--purge requires --uninstall"
  [ -z "$requested_port" ] || valid_port "$requested_port" ||
    fail "invalid port: $requested_port"
  case "$requested_version" in
  *[!0-9A-Za-z._-]*) fail "invalid version: $requested_version" ;;
  v[0-9]*) requested_version="${requested_version#v}" ;;
  esac

  [ -n "${HOME:-}" ] || fail "HOME is not set"
  bin_dir="${THYRA_INSTALL_DIR-$HOME/.local/bin}"
  [ -n "$bin_dir" ] || fail "install directory must not be empty"
  config_dir="$HOME/.config/thyra"
  config_file="$config_dir/thyra.env"
  state_file="$config_dir/installer-herdr.sha256"
  staged_files=""
  tmp=""

  if [ "$mode" = uninstall ]; then
    uninstall
    return 0
  fi

  for command in curl tar install uname awk mktemp; do
    command -v "$command" >/dev/null 2>&1 ||
      fail "required command not found: $command"
  done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
    fail "required command not found: sha256sum or shasum"

  os="$(uname -s)"
  if [ "$os" = Linux ] && [ "$(uname -o 2>/dev/null || true)" = Android ]; then
    fail "Android is not supported; run Thyra on a Linux or macOS host and open it from your phone"
  fi
  rosetta=0
  if [ "$os" = Darwin ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    rosetta=1
  fi
  platform="$(thyra_platform "$os" "$(uname -m)" "$rosetta")" ||
    fail "unsupported platform: $os $(uname -m). On Windows, use install.ps1."

  base="$(release_base "${THYRA_INSTALL_BASE_URL:-${THYRA_RELEASE_BASE_URL:-}}" "$requested_version")"
  curl_protocol "$base" >/dev/null || fail "invalid release base URL"

  mkdir -p "$bin_dir"
  require_regular_target "$bin_dir/thyra"
  require_regular_target "$bin_dir/herdr"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/thyra-install.XXXXXX")"
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  # 1. Download and verify Thyra.
  if [ -n "$requested_version" ]; then
    archive_name="thyra-v$requested_version-$platform.tar.xz"
  else
    archive_name="thyra-$platform.tar.xz"
  fi
  say "Downloading Thyra for $platform..."
  fetch "$base/$archive_name" "$tmp/$archive_name" ||
    fail "download failed: $base/$archive_name"
  fetch "$base/$archive_name.sha256" "$tmp/$archive_name.sha256" 4096 ||
    fail "download failed: $base/$archive_name.sha256"
  expected="$(checksum_from_file "$tmp/$archive_name.sha256" "$archive_name")" ||
    fail "invalid package checksum file"
  [ "$(sha256_of "$tmp/$archive_name")" = "$expected" ] ||
    fail "package checksum mismatch"

  package_dir="thyra-$platform"
  tar -xJf "$tmp/$archive_name" -C "$tmp" "$package_dir/VERSION" "$package_dir/thyra" ||
    fail "cannot extract $archive_name (on Linux, install xz-utils or xz)"
  binary="$tmp/$package_dir/thyra"
  [ -d "$tmp/$package_dir" ] && [ ! -L "$tmp/$package_dir" ] ||
    fail "package directory is invalid"
  [ -f "$tmp/$package_dir/VERSION" ] && [ ! -L "$tmp/$package_dir/VERSION" ] ||
    fail "package VERSION file is missing or invalid"
  [ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] ||
    fail "package binary is missing, invalid, or not executable"
  package_name="" package_version="" package_platform="" extra=""
  read -r package_name package_version package_platform extra \
    <"$tmp/$package_dir/VERSION" || fail "invalid package VERSION file"
  [ "$package_name" = thyra ] && [ -z "$extra" ] && [ -n "$package_version" ] ||
    fail "invalid package VERSION file"
  [ "$package_platform" = "$platform" ] ||
    fail "package platform is $package_platform, expected $platform"
  [ -z "$requested_version" ] || [ "$package_version" = "$requested_version" ] ||
    fail "package version is $package_version, expected $requested_version"
  binary_version="$("$binary" --version 2>/dev/null)" ||
    fail "cannot run the Thyra binary; it needs glibc 2.17+ on Linux (Alpine/musl is unsupported)"
  [ "$binary_version" = "thyra $package_version" ] ||
    fail "binary version does not match package VERSION"

  # 2. Download and verify the Herdr build this Thyra release pins.
  herdr_path="$bin_dir/herdr"
  herdr_plan=skip
  if [ "$no_herdr" != 1 ]; then
    if fetch "$base/herdr-release.json" "$tmp/herdr-release.json" 65536; then
      target="$(herdr_target "$platform")"
      herdr_repository="$(pin_value "$tmp/herdr-release.json" repository)"
      herdr_tag="$(pin_value "$tmp/herdr-release.json" tag)"
      herdr_version="$(pin_value "$tmp/herdr-release.json" version)"
      herdr_sha256="$(pin_sha256 "$tmp/herdr-release.json" "$target")"
      if [ -z "$herdr_repository" ] || [ -z "$herdr_tag" ] ||
        [ -z "$herdr_version" ] || ! valid_sha256 "$herdr_sha256"; then
        fail "herdr-release.json does not pin a Herdr build for $target"
      fi
      installed_sha=-
      [ -f "$herdr_path" ] && installed_sha="$(sha256_of "$herdr_path")"
      recorded_sha="$(installed_herdr_record)"
      other=0
      path_herdr="$(command -v herdr 2>/dev/null || true)"
      if [ -n "$path_herdr" ] && [ "$path_herdr" != "$herdr_path" ]; then
        other=1
      fi
      herdr_plan="$(herdr_action "$installed_sha" "${recorded_sha:--}" \
        "$herdr_sha256" "$other" "$replace_herdr")"
    else
      warn "this release does not pin a Herdr build; skipping Herdr"
    fi
  fi
  case "$herdr_plan" in
  install | upgrade | replace)
    herdr_base="${THYRA_HERDR_BASE_URL:-https://github.com/$herdr_repository/releases/download/$herdr_tag}"
    herdr_base="$(release_base "$herdr_base" "")"
    say "Downloading Herdr $herdr_version ($herdr_repository $herdr_tag)..."
    fetch "$herdr_base/herdr-$target" "$tmp/herdr" ||
      fail "download failed: $herdr_base/herdr-$target"
    [ "$(sha256_of "$tmp/herdr")" = "$herdr_sha256" ] ||
      fail "Herdr checksum mismatch"
    chmod 755 "$tmp/herdr"
    "$tmp/herdr" --version >/dev/null 2>&1 || fail "cannot run the downloaded Herdr binary"
    ;;
  esac

  # 3. Install binaries atomically, keeping *.previous copies.
  require_regular_target "$bin_dir/thyra"
  install_file "$binary" "$bin_dir/thyra"
  say "Installed Thyra $package_version to $bin_dir/thyra"
  case "$herdr_plan" in
  install | upgrade | replace)
    require_regular_target "$herdr_path"
    install_file "$tmp/herdr" "$herdr_path"
    mkdir -p "$config_dir"
    chmod 700 "$config_dir"
    printf '%s  %s\n' "$herdr_sha256" "$herdr_path" >"$state_file"
    say "Installed Herdr $herdr_version to $herdr_path"
    if [ "$herdr_plan" != install ]; then
      say "  A Herdr server that is already running keeps the previous build until it"
      say "  restarts; restarting it ends its panes, so do that when convenient."
    fi
    ;;
  current)
    mkdir -p "$config_dir"
    chmod 700 "$config_dir"
    printf '%s  %s\n' "$herdr_sha256" "$herdr_path" >"$state_file"
    say "Herdr $herdr_version at $herdr_path is already current"
    ;;
  keep)
    existing="$herdr_path"
    [ -f "$existing" ] || existing="$path_herdr"
    say "Keeping the existing Herdr at $existing ($("$existing" --version 2>/dev/null || echo 'unknown version'))."
    say "  Thyra is tested with Herdr $herdr_version from $herdr_repository; rerun with --replace-herdr to install it."
    ;;
  esac

  # 4. Services.
  service_state=none
  if [ "$no_service" = 1 ]; then
    :
  elif [ "$os" = Linux ] && ! systemd_user_available; then
    warn "systemd user services are unavailable here (WSL without systemd, a container, or no login session); skipping services"
  else
    write_service_config
    if [ "$no_herdr" != 1 ]; then
      PATH="$bin_dir:$PATH" "$bin_dir/thyra" herdr setup </dev/null ||
        warn "Herdr did not start; open Thyra and choose Set up Herdr, or run: thyra herdr setup"
    fi
    if "$bin_dir/thyra" service install </dev/null; then
      service_state=installed
    else
      warn "could not install the Thyra service; see thyra service --help"
    fi
  fi

  # 5. Summary.
  say ""
  if [ "$service_state" = installed ]; then
    port="$(env_value "$config_file" PORT)"
    port="${port:-8787}"
    host="$(env_value "$config_file" HOST)"
    if wait_for_thyra "$port"; then
      say "Thyra $package_version is running."
    else
      warn "Thyra did not answer on port $port yet; check: thyra service status"
    fi
    case "$host" in
    127.0.0.1 | localhost | ::1 | "")
      say "  Open http://127.0.0.1:$port on this machine (no login needed)."
      ;;
    *)
      say "  Create your login: thyra user add <name> --admin (prints a passkey enrollment link;"
      say "  passkeys need HTTPS or localhost)."
      ;;
    esac
    say "  Service config: $config_file"
  else
    say "Thyra $package_version is installed. Start it with:"
    [ "$herdr_plan" = skip ] || say "  herdr server &"
    say "  thyra              # then open http://127.0.0.1:8787"
  fi
  case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) say "  Add $bin_dir to PATH to run thyra and herdr directly." ;;
  esac
  say ""
  say "Next steps:"
  say "  - Phone and other devices: join Tailscale on both, then run"
  say "      tailscale serve --bg --https=443 http://127.0.0.1:${port:-8787}"
  say "    and open the printed https://<machine>.<tailnet>.ts.net address."
  say "  - Install as an app: open Thyra, then Share > Add to Home Screen (iPhone)"
  say "    or the browser's Install app action (Chrome, Edge)."
  if [ "$os" = Linux ] && [ "$service_state" = installed ]; then
    say "  - Keep services running after logout: sudo loginctl enable-linger \"\$USER\""
  fi
  say "  - Upgrade: rerun this installer. Remove: add --uninstall (sh -s -- --uninstall)."
}

if [ "${THYRA_INSTALLER_LIBRARY:-}" != 1 ]; then
  main "$@"
fi
