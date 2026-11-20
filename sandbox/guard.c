// Linux-only. Do not start the shell unless every restriction is in place.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#else
#error unsupported architecture
#endif

static void fail(void) {
    perror("terminal guard");
    _exit(126);
}

static void allow_path(int ruleset, const char *path, unsigned long long access) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) fail();

    struct landlock_path_beneath_attr rule = {
        .allowed_access = access,
        .parent_fd = fd,
    };
    if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0))
        fail();
    close(fd);
}

static void restrict_filesystem(const char *workspace) {
    const int minimum_abi = 3;
    if (syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) < minimum_abi)
        fail();

    // ABI 3 defines filesystem rights in bits 0 through 14, inclusive.
    const unsigned long long all_abi3_rights = (1ULL << 15) - 1;
    const unsigned long long read_and_execute =
        LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
    struct landlock_ruleset_attr policy = {.handled_access_fs = all_abi3_rights};
    int ruleset = syscall(__NR_landlock_create_ruleset, &policy, sizeof policy, 0);
    if (ruleset < 0) fail();

    allow_path(ruleset, "/etc/ssl/certs", read_and_execute);
    allow_path(ruleset, "/usr", read_and_execute);
    allow_path(ruleset, workspace, all_abi3_rights);
    allow_path(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE);
    allow_path(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE);

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail();
    if (syscall(__NR_landlock_restrict_self, ruleset, 0)) fail();
    close(ruleset);
}

// Each matching syscall returns EPERM; otherwise proceed to the next rule.
#define DENY_SYSCALL(name) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##name, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static void restrict_syscalls(void) {
    struct sock_filter rules[] = {
        // Only interpret native syscall numbers. Reject tagged numbers as well.
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

        // socket(): allow AF_UNIX for the local egress proxy, deny all other families.
        // Non-socket syscalls skip these four instructions with the syscall number intact.
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        DENY_SYSCALL(bind),
        DENY_SYSCALL(listen),
        DENY_SYSCALL(socketpair),
        DENY_SYSCALL(io_uring_setup),
        DENY_SYSCALL(kill),
        DENY_SYSCALL(tkill),
        DENY_SYSCALL(tgkill),
        DENY_SYSCALL(pidfd_send_signal),
        DENY_SYSCALL(ptrace),
        DENY_SYSCALL(process_vm_writev),
        DENY_SYSCALL(process_vm_readv),
        DENY_SYSCALL(pidfd_getfd),
        DENY_SYSCALL(setsid),
        DENY_SYSCALL(setpgid),
        DENY_SYSCALL(unshare),
        DENY_SYSCALL(setns),
        DENY_SYSCALL(rt_sigqueueinfo),
        DENY_SYSCALL(rt_tgsigqueueinfo),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {.len = sizeof rules / sizeof rules[0], .filter = rules};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}

static void limit_file_size(void) {
    const rlim_t file_size_bytes = 64ULL * 1024 * 1024;
    const struct rlimit file_size = {.rlim_cur = file_size_bytes, .rlim_max = file_size_bytes};
    if (setrlimit(RLIMIT_FSIZE, &file_size)) fail();
}

int main(int argc, char **argv) {
    if (argc != 3) return 126;
    const char *workspace = argv[1];
    const char *command = argv[2];

    restrict_filesystem(workspace);
    restrict_syscalls();
    limit_file_size();

    if (chdir(workspace)) fail();
    execl("/bin/sh", "sh", "-c", command, (char *)NULL);
    fail();
}
