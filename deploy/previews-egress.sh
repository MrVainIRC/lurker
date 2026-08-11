#!/bin/bash
# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0
#
# Lurker — egress containment for the lurker-previews decoder
# ===========================================================
#
#   sudo ./previews-egress.sh              # apply the rules now
#   sudo ./previews-egress.sh --install    # …and re-apply on every boot
#
# The decoder exists so that the box parsing bytes strangers chose is NOT the
# box holding your database and your users' sessions. That argument only holds
# if a compromised decoder can reach the public internet and nothing else — not
# your LAN, not your other containers, not the Docker host itself. An
# in-process SSRF guard defends against a malicious URL; it does nothing about
# a malicious process, because a process that owns the parser is already past
# every check the parser makes. Only the network can say no to that.
#
# So this script installs the network half, on a Linux host running Docker:
#
#   * DOCKER-USER rules DROPping decoder → RFC1918, link-local (the cloud
#     metadata service lives at 169.254.169.254) and CGNAT,
#   * an INPUT rule for the host itself — ⚠ container→host traffic never
#     touches DOCKER-USER, so forward rules alone leave your own sshd
#     reachable from the container that runs ffmpeg on hostile input,
#   * a RETURN rule first, so Lurker ↔ decoder traffic on the shared bridge
#     survives the DROPs above (the decoder's own subnet is inside 172.16/12).
#
# ⚠ DROP, never REJECT. The decoder's boot self-test reads a completed connect
# as "the policy is not in force"; a REJECT answers RST, which it cannot tell
# apart from a refusal it should ignore. DROP makes blocked targets time out,
# which is the unambiguous signal.
#
# With the rules in place, remove LURKER_PREVIEWS_ALLOW_PRIVATE (or set it to
# 0) so the self-test runs for real — from then on the decoder refuses to serve
# if the rules ever lapse, instead of quietly parsing hostile bytes on your LAN.
#
# ⚠ Re-run this after anything that RECREATES the decoder container (an update,
# `docker compose down && up`): the rules are scoped to the address Docker gave
# it, and a new container can be given a new one. Re-running is idempotent and
# takes seconds. You will not have to guess when — a decoder whose rules no
# longer match it refuses to serve and says so in its log; previews report
# themselves unavailable and nothing else is affected.
#
# This is the self-hosted equivalent of what the hosted fleet does per cell.

set -euo pipefail

CONTAINER="${LURKER_PREVIEWS_CONTAINER:-lurker-previews}"
UNIT="lurker-previews-egress.service"
WAIT_SECONDS="${LURKER_PREVIEWS_WAIT:-60}"

# The destinations a preview decoder has no business reaching. Everything else
# — the public internet — stays open, because fetching from it is the job.
PRIVATE_V4=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10)
PRIVATE_V6=(fc00::/7 fe80::/10 ::1/128)

log() { echo "[previews-egress] $*"; }
die() {
  echo "[previews-egress] ERROR: $*" >&2
  exit 1
}

need_root() { [ "$(id -u)" -eq 0 ] || die "run this as root (sudo)."; }

# ── Rule plumbing ───────────────────────────────────────────────────────────

# ⚠⚠ Every rule this script writes is tagged, and the tag names the RUN that
# wrote it. Rules go in first and the older generation comes out afterwards, so
# containment is never briefly absent — during the overlap both generations are
# in force, which can only be stricter, and a run that dies halfway leaves the
# decoder over-contained rather than exposed.
#
# The cleanup is not tidiness either. These rules name the decoder's ADDRESS, a
# recreated decoder can be given a different one, and Docker hands freed
# addresses to whatever asks next: leave the old rules behind and the day
# Lurker itself lands on that address, Lurker quietly loses the LAN and this
# host. Replacing the generation makes the rule set a statement about the
# decoder that exists now.
# ⚠ No punctuation beyond the dash: iptables prints a comment containing a
# colon (or a space) QUOTED in `-S` output, and a quoted token cannot be handed
# straight back to `-D` — the delete then matches nothing, silently, and the
# generations pile up instead of rolling over.
TAG_PREFIX="lurker-previews-egress"
RUN_TAG="${TAG_PREFIX}-$$-$(date +%s)"

add() {
  local ipt="$1" chain="$2"
  shift 2
  # The match goes BEFORE the rule spec: iptables takes its options in any
  # order, but a `-m` trailing `-j DROP` is the arrangement most likely to be
  # read as belonging to the target instead of the rule.
  "$ipt" -I "$chain" -m comment --comment "$RUN_TAG" "$@"
}

# Delete the rules from every run but this one. Parsing `-S` output is safe
# here precisely because the tag has no spaces: no quoting to unpick.
#
# ⚠ No pipeline: `set -o pipefail` turns a grep that matches nothing — the
# ordinary case on a first run — into a failed command, and `set -e` then ends
# the script before it has said anything at all.
purge_older_generations() {
  local ipt="$1" chain line rules arg args
  for chain in DOCKER-USER INPUT; do
    rules="$("$ipt" -S "$chain" 2>/dev/null || true)"
    while IFS= read -r line; do
      case "$line" in
        *"$RUN_TAG"*) continue ;; # this run's work, leave it
        *"$TAG_PREFIX"*) ;;       # an older generation, delete it
        *) continue ;;            # someone else's rule, never touch it
      esac
      # shellcheck disable=SC2086 # deliberate: split the rule spec into args
      set -- $line
      shift 2 # drop the leading "-A <chain>"
      # Belt and braces against the quoting above: strip any quotes iptables
      # decided to print, since they are not part of the value it stored.
      args=()
      for arg in "$@"; do
        arg="${arg#\"}"
        args+=("${arg%\"}")
      done
      "$ipt" -D "$chain" "${args[@]}" || true
    done <<< "$rules"
  done
  return 0
}

# `iptables -I` prepends, so the LAST thing inserted ends up FIRST in the
# chain. The RETURN therefore has to be added after the DROPs it protects.
apply_rules() {
  local ipt="$1" ip="$2" subnet="$3"
  shift 3
  local dest
  for dest in "$@"; do
    add "$ipt" DOCKER-USER -s "$ip" -d "$dest" -j DROP
  done
  add "$ipt" INPUT -s "$ip" -j DROP
  # ⚠ Without this, the DROP on the decoder's own private range kills the
  # replies to Lurker's requests — the bridge subnet is itself RFC1918, and
  # with br_netfilter loaded, bridge traffic traverses DOCKER-USER too.
  if [ -n "$subnet" ]; then
    add "$ipt" DOCKER-USER -s "$ip" -d "$subnet" -j RETURN
  fi
}

# ── Discovery ───────────────────────────────────────────────────────────────

# Wait for the container: on boot this runs right after dockerd, which may
# still be starting the containers Compose asked it to restart.
wait_for_container() {
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if docker inspect "$CONTAINER" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "no container named '$CONTAINER' after ${WAIT_SECONDS}s. Start the decoder first
       (docker compose -f docker-compose.yml -f docker-compose.previews.yml up -d),
       or set LURKER_PREVIEWS_CONTAINER if you named it something else."
}

# The network's first subnet of the given family ("4" or "6"), or nothing.
#
# ⚠ Deliberately no `| head -1`: under `set -o pipefail`, a `head` that exits
# after the line it wanted makes the whole pipeline return SIGPIPE (141), and
# `set -e` then kills this script before it has logged a single word. It is a
# race, so it hides on a fast host and bites on a slow one.
subnet_of() {
  local out token
  out="$(docker network inspect "$1" -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)"
  for token in $out; do
    case "$token" in
      *:*) if [ "$2" = "6" ]; then
        echo "$token"
        return 0
      fi ;;
      *) if [ "$2" != "6" ]; then
        echo "$token"
        return 0
      fi ;;
    esac
  done
  return 0
}

# ⚠ Rules are scoped to the decoder's own ADDRESS, not to its bridge subnet.
# Lurker sits on that same bridge — it has to, to reach the decoder by name —
# and a subnet-wide rule would cut Lurker off from your LAN and this host too,
# silently breaking whatever it legitimately reaches there. The cost is that a
# recreated container needs a re-run; that failure is loud (the decoder refuses
# to serve), which is the trade this whole subsystem is built to prefer.
apply_all() {
  local found=0 net ip ip6 subnet subnet6
  # ⚠ Pipe-separated, and each address is checked for SHAPE rather than for
  # emptiness: Docker 29 renders an address a container doesn't have as the
  # literal string "invalid IP" (Go's netip.Addr zero value), which is neither
  # empty nor one field.
  while IFS='|' read -r net ip ip6; do
    [ -n "$net" ] || continue
    case "$ip" in *[!0-9.]* | '') ip='' ;; esac
    case "$ip6" in *[!0-9a-fA-F:]* | '') ip6='' ;; esac
    subnet="$(subnet_of "$net" 4)"
    if [ -n "$ip" ]; then
      log "containing ${CONTAINER} at ${ip} on ${net} (subnet ${subnet:-unknown})"
      apply_rules iptables "$ip" "$subnet" "${PRIVATE_V4[@]}"
      found=1
    fi
    # IPv6 is off on a default Docker install, so this usually finds nothing —
    # but where it IS on, forgetting it would leave the whole policy open on
    # the other address family.
    if [ -n "$ip6" ]; then
      command -v ip6tables >/dev/null 2>&1 ||
        die "$CONTAINER has an IPv6 address ($ip6) but ip6tables is missing — its egress
       cannot be contained on this host."
      subnet6="$(subnet_of "$net" 6)"
      log "containing ${CONTAINER} at ${ip6} on ${net} (IPv6)"
      apply_rules ip6tables "$ip6" "$subnet6" "${PRIVATE_V6[@]}"
      found=1
    fi
  done < <(docker inspect "$CONTAINER" \
    -f '{{range $net, $c := .NetworkSettings.Networks}}{{$net}}|{{$c.IPAddress}}|{{$c.GlobalIPv6Address}}{{"\n"}}{{end}}')
  [ "$found" -eq 1 ] || die "$CONTAINER has no network addresses — is it running?"
  # Only now that this generation is in force does the previous one go.
  purge_older_generations iptables
  if command -v ip6tables >/dev/null 2>&1; then purge_older_generations ip6tables; fi
}

# ── Verification ────────────────────────────────────────────────────────────

# The rules are only half the point; the decoder confirming them is the other
# half. Restart it so its boot self-test runs UNDER the rules we just applied
# — on a reboot the container will usually have started before this script
# did, and a self-test that ran too early proves nothing.
verify() {
  # ⚠ Read only the logs from THIS start. The decoder logs its verdict once, at
  # boot, and the line from the previous start is still sitting in the log — on
  # a first run that line says REFUSING TO SERVE, which is exactly the answer
  # we would otherwise misreport as a failure of the rules we just installed.
  # ⚠ Epoch seconds, not a formatted timestamp: `docker logs --since` reads a
  # zoneless RFC3339 string as LOCAL time, so a UTC one silently selects a
  # window in the future and matches nothing at all.
  local since
  since="$(date +%s)"
  log "restarting $CONTAINER so its boot self-test runs under these rules..."
  docker restart "$CONTAINER" >/dev/null
  local i logs
  for ((i = 0; i < 30; i++)); do
    sleep 1
    logs="$(docker logs --since "$since" "$CONTAINER" 2>&1 || true)"
    case "$logs" in
      *'ready — egress self-test passed'*)
        log "self-test PASSED — the decoder can reach the internet and nothing private."
        return 0
        ;;
      *'self-test SKIPPED'*)
        log "⚠ the decoder still has LURKER_PREVIEWS_ALLOW_PRIVATE=1, so it did not check."
        log "  The rules are applied; set LURKER_PREVIEWS_ALLOW_PRIVATE=0 and recreate the"
        log "  container to have it verify them for you on every start."
        return 0
        ;;
      *'REFUSING TO SERVE'*)
        echo "$logs" >&2
        die "the decoder can still reach a private address (named above). The rules did not
       take — check for a firewall that rewrites the filter table (ufw, firewalld,
       nftables) and apply these AFTER it, then re-run."
        ;;
    esac
  done
  die "the decoder logged neither success nor refusal within 30s. Check: docker logs $CONTAINER"
}

# ── Boot persistence ────────────────────────────────────────────────────────

# ⚠ Not iptables-persistent. Docker recreates DOCKER-USER when the daemon
# starts and container addresses can change on recreate, so a saved snapshot of
# the table is the wrong shape for this: what has to survive is the DERIVATION,
# not the rules. A oneshot unit that re-runs this script does that, and
# PartOf=docker.service means restarting Docker re-applies them too.
install_unit() {
  local self
  self="$(readlink -f "$0")"
  # The rules are already applied at this point, so a host without systemd
  # gets a working decoder and an honest warning, not a failed run.
  if ! command -v systemctl >/dev/null 2>&1; then
    log "⚠ no systemd here, so the rules were NOT made persistent. Arrange to run"
    log "  $self after Docker starts, or they lapse on the next boot — at which"
    log "  point the decoder refuses to serve rather than run uncontained."
    return 0
  fi
  log "installing $UNIT (re-applies these rules on boot and on docker restart)"
  cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Egress containment for the lurker-previews decoder
Requires=docker.service
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$self
Environment=LURKER_PREVIEWS_CONTAINER=$CONTAINER

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null
  log "installed. Undo with: systemctl disable --now $UNIT"
}

# ── Run ─────────────────────────────────────────────────────────────────────

need_root
command -v docker >/dev/null 2>&1 || die "docker not found."
command -v iptables >/dev/null 2>&1 || die "iptables not found."

wait_for_container
apply_all
verify
if [ "${1:-}" = "--install" ]; then
  install_unit
fi
log "done."
