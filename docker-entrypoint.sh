#!/bin/sh
# Hands /data to the user the server runs as, then drops root immediately.
#
# /data is a bind mount. Docker creates a missing one owned by root, and a
# directory left behind by an earlier run keeps whatever owner it had, so a
# container that simply runs as an unprivileged user cannot write its own
# database. Fixing that from the host means `chown` before every fresh start,
# which is a step to forget and a step to document; doing it here means the
# container works against any directory it is given.
#
# Root is used for exactly one chown and is gone before the server starts.
set -e

uid="${CARSCOPE_UID:-1000}"
gid="${CARSCOPE_GID:-1000}"

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged, because compose was told to run as someone specific.
  # Nothing to hand over; the server reports it if the directory is not writable.
  exec "$@"
fi

# A rootless or user-namespaced daemon can refuse this, and so can a read-only
# network mount. Failing here would be worse than letting the server say plainly
# which directory it cannot write to.
chown "$uid:$gid" /data 2>/dev/null || true

# setpriv comes from util-linux, which Debian marks Essential, so it is in every
# Debian image including slim. It takes numeric ids, which matters: the account
# the operator names need not exist in the image's /etc/passwd.
exec setpriv --reuid "$uid" --regid "$gid" --clear-groups "$@"
