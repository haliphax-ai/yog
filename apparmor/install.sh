#!/usr/bin/env bash
set -euo pipefail

# Install and reload the yog AppArmor profile, then confirm it is active.
# The host profile lives at /etc/apparmor.d/yog and is separate from the
# image build — after editing apparmor/yog.profile you must run this (or
# the equivalent) or the container keeps using the stale profile.
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/yog.profile"
dst="/etc/apparmor.d/yog"

sudo cp "$src" "$dst"
sudo apparmor_parser -r -W "$dst"
sudo aa-status | grep -w yog
