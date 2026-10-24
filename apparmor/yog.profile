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
  # helper; kept here so direct mount attempts also behave).
  capability mount,
  capability sys_admin,

  # Runtime + tool binaries
  /app/** r,
  /usr/bin/{node,bash,sh,dash,env,sed,grep,cat,echo,ls,ps,tar,gzip,bzip2,xz,find,head,tail,cut,tr,awk,sort,uniq,wc,date,hostname,id,whoami,dirname,basename,mkdir,rmdir,rm,cp,mv,ln,chmod,chown,touch,file,stat,du,df,mount,umount,fusermount,curl,wget,git,jq,rg,gpg,openssl,tee,printf,seq,nohup,setsid} mr,
  /usr/sbin/{fusermount,groupadd,useradd} mr,

  # FUSE device and mounts
  /dev/fuse rw,
  mount fstype=fuse,
  mount fstype=fuse.*,
  umount,

  # Working tree (agent HOME + state dir + tmp)
  /home/agent/ rw,
  /home/agent/** rw,
  /tmp/ rw,
  /tmp/** rw,

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
