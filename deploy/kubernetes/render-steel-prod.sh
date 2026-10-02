#!/bin/sh
set -eu

profile=${1:-}
case "$profile" in
  ovh1|ovh2|ovh3|east5) ;;
  *)
    echo "usage: $0 {ovh1|ovh2|ovh3|east5}" >&2
    exit 2
    ;;
esac

manifest_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sed "s/browser-session-ovh1\.tlon\.network/browser-session-${profile}.tlon.network/g" \
  "$manifest_dir/steel.prod.yaml"
