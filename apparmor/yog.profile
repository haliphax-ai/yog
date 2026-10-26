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

  # Runtime + tool binaries. The harness/worker (node, setpriv, shell) run
  # confined under this profile (`ix` = inherit). The agent's bash escapes
  # unconfined (`Ux`) so the model can execute arbitrary commands without
  # enumerating every utility here; fusermount likewise escapes so the setuid
  # helper can perform the mount.
  /app/** r,
  /usr/bin/bash Ux,
  /usr/bin/{sh,dash,env,sed,grep,cat,echo,ls,ps,tar,gzip,bzip2,xz,find,head,tail,cut,tr,awk,sort,uniq,wc,date,hostname,id,whoami,dirname,basename,mkdir,rmdir,rm,cp,mv,ln,chmod,chown,touch,file,stat,du,df,mount,umount,curl,wget,git,jq,rg,gpg,openssl,tee,printf,seq,nohup,setsid,setpriv,capsh} ix,
  /usr/local/bin/node ix,
  /usr/sbin/fusermount Ux,
  /usr/sbin/{groupadd,useradd} ix,

  # FUSE device and mounts (fstype takes literal types — no wildcards)
  /dev/fuse rw,
  mount fstype=fuse,
  umount,

  # Working tree: agent HOME (model-executed bash), daemon HOME (state db +
  # audit trail), tmp
  /home/agent/ rw,
  /home/agent/** rw,
  /home/yog/ rw,
  /home/yog/** rw,
  /tmp/ rw,
  /tmp/** rw,

  # FUSE mount root (mounted by the daemon; served to the agent)
  /yog/ rw,
  /yog/** rw,

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

  # Network (OpenAI-compatible API calls)
  network inet tcp,
  network inet6 tcp,
  network inet dgram,
  network inet6 dgram,
}
