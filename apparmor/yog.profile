abi <abi/4.0>,

#include <tunables/global>

# AppArmor profile for the yog container (referenced via
# `docker run --security-opt apparmor=yog ...`).
#
# Load on the host before container start:
#   sudo apparmor_parser -r -W apparmor/yog.profile
#
# This profile is intentionally broad: the harness runs a language-model agent
# that executes arbitrary bash, so it needs a general-purpose Linux userspace
# surface plus the FUSE bits. Tighten the path/network rules as the agent's
# toolset narrows.
profile yog flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/consoles>
  #include <abstractions/nameservice>
  #include <abstractions/nis>

  # Capabilities needed for FUSE mounting (used via the setuid fusermount
  # helper; kept here so direct mount attempts also behave) and for the
  # daemon/agent split (the harness spawns its bash worker as the agent user).
  # Note: there is no `capability mount` — mount(2) is gated by sys_admin and
  # the mount/umount rules below.
  capability sys_admin,
  capability setuid,
  capability setgid,
  # The entrypoint re-owns the state volume (/var/lib/yog) to the yog user.
  capability chown,

  # Runtime + tool binaries. The harness/worker (node, setpriv, shell) run
  # confined under this profile (`ix` = inherit). The agent's bash escapes
  # unconfined (`Ux`) so the model can execute arbitrary commands without
  # enumerating every utility here; fusermount likewise escapes so the setuid
  # helper can perform the mount.
  # /app contains native addons (turso/libsql .node bindings) loaded via
  # dlopen, which requires mmap (`m`) as well as read (`r`).
  /app/** rm,
  /usr/bin/bash Ux,
  /usr/bin/{sh,dash,env,sed,grep,cat,echo,ls,ps,tar,gzip,bzip2,xz,find,head,tail,cut,tr,awk,sort,uniq,wc,date,hostname,id,whoami,dirname,basename,mkdir,rmdir,rm,cp,mv,ln,chmod,chown,touch,file,stat,du,df,mount,umount,curl,wget,git,jq,rg,gpg,openssl,tee,printf,seq,nohup,setsid,setpriv,capsh,ldd} ix,
  # node (re)opens its own binary and ldd when spawning the worker — exec
  # (`ix`) alone does not grant read, so give both.
  /usr/local/bin/node mr,
  /usr/local/bin/node ix,
  /usr/bin/ldd r,
  # fusermount is at /usr/bin on Debian (and /usr/sbin on some distros);
  # it must escape so its setuid mount helper works.
  /usr/bin/fusermount Ux,
  /usr/sbin/fusermount Ux,
  /usr/sbin/{groupadd,useradd} ix,

  # FUSE device and mounts (fstype takes literal types — no wildcards)
  /dev/fuse rw,
  mount fstype=fuse,
  umount,

  # Working tree: agent HOME (model-executed bash), daemon HOME, and the
  # daemon's state dir (/var/lib/yog). `k` (lock) is required for flock(2),
  # which the turso/libsql native binding uses on the database file
  # (confirmed by audit: requested_mask="k"). The state tree gets read/write/
  # mmap/lock; creating new files is covered by write on the directory (there
  # is no `c` mode — that was a parser error).
  /home/agent/ rwk,
  /home/agent/** rwk,
  /home/yog/ rwk,
  /home/yog/** rwk,
  /var/lib/yog/ rwkm,
  /var/lib/yog/** rwkm,
  /tmp/ rwk,
  /tmp/** rwk,

  # FUSE mount root (mounted by the daemon; served to the agent)
  /yog/ rwk,
  /yog/** rwk,

  # Read-only system surface
  /etc/** r,
  /lib/** r,
  /lib64/** r,
  /usr/lib/** r,
  /usr/share/** r,
  /proc/** r,
  /sys/** r,
  /run/** r,
  /dev/ r,
  /dev/** r,

  # Network (OpenAI-compatible API calls). The daemon also *listens* on the
  # configured bind address (YOG_HOST, 0.0.0.0:8111 in the container; the
  # launcher publishes it to the host as YOG_PORT) — inbound TCP accept on
  # that address is covered by the same inet tcp rules below, so listening
  # needs no extra capability beyond these network rules.
  network inet tcp,
  network inet6 tcp,
  network inet dgram,
  network inet6 dgram,
