#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define JINGLER_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define JINGLER_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "Unsupported offload launcher architecture"
#endif

#define DENY_ERRNO (SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

static int deny_network_sockets(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, JINGLER_AUDIT_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_unshare, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setns, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_mount, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_pivot_root, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 9),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_PACKET, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_NETLINK, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("offload-launch: missing executable\n", stderr);
    return 64;
  }
  if (setgroups(0, NULL) != 0 || setgid(65532) != 0 || setuid(65532) != 0) {
    perror("offload-launch: privilege drop failed");
    return 70;
  }
  if (deny_network_sockets() != 0) {
    perror("offload-launch: network isolation failed");
    return 70;
  }
  execvp(argv[1], &argv[1]);
  perror("offload-launch: exec failed");
  return errno == ENOENT ? 127 : 126;
}
