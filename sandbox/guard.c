// Linux-only, fail closed. Run before every workspace command, including readiness.
#define _GNU_SOURCE
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
static void fail(void){perror("terminal guard");_exit(126);}
static void allow(int rules,const char *path,unsigned long long access){int fd=open(path,O_PATH|O_CLOEXEC);if(fd<0)fail();struct landlock_path_beneath_attr r={.allowed_access=access,.parent_fd=fd};if(syscall(__NR_landlock_add_rule,rules,LANDLOCK_RULE_PATH_BENEATH,&r,0))fail();close(fd);}
#define BLOCK(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
int main(int argc,char **argv){if(argc!=3)return 126;
#if defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#else
#error unsupported architecture
#endif
if(syscall(__NR_landlock_create_ruleset,NULL,0,LANDLOCK_CREATE_RULESET_VERSION)<3)fail();
unsigned long long full=(1ULL<<15)-1, ro=LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR|LANDLOCK_ACCESS_FS_EXECUTE;
struct landlock_ruleset_attr a={.handled_access_fs=full};int r=syscall(__NR_landlock_create_ruleset,&a,sizeof a,0);if(r<0)fail();
allow(r,"/etc/ssl/certs",ro);allow(r,"/usr",ro);allow(r,argv[1],full);allow(r,"/dev/null",LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_WRITE_FILE);allow(r,"/dev/urandom",LANDLOCK_ACCESS_FS_READ_FILE);
if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||syscall(__NR_landlock_restrict_self,r,0))fail();close(r);
struct sock_filter f[]={BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,ARCH,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),// Only Unix sockets, for the filesystem-local public egress proxy. No IP sockets in commands.
BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_socket,0,4),BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AF_UNIX,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),BLOCK(bind),BLOCK(listen),BLOCK(socketpair),BLOCK(io_uring_setup),BLOCK(kill),BLOCK(tkill),BLOCK(tgkill),BLOCK(pidfd_send_signal),BLOCK(ptrace),BLOCK(process_vm_writev),BLOCK(process_vm_readv),BLOCK(pidfd_getfd),BLOCK(setsid),BLOCK(setpgid),BLOCK(unshare),BLOCK(setns),BLOCK(rt_sigqueueinfo),BLOCK(rt_tgsigqueueinfo),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};
struct sock_fprog p={sizeof f/sizeof *f,f};if(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&p))fail();
struct rlimit lim={64,64};if(setrlimit(RLIMIT_NPROC,&lim))fail();lim.rlim_cur=lim.rlim_max=64*1024*1024;if(setrlimit(RLIMIT_FSIZE,&lim))fail();if(chdir(argv[1]))fail();execl("/bin/sh","sh","-c",argv[2],(char*)0);fail();}
