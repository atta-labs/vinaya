// Compiled by `resolves.ts` through `bun:ffi`'s `cc` with `-nostdlib`: counts the entries of a folder by listing it
// with raw Linux syscalls (`openat`, `getdents64`), out of the probe's sight, since no `node:fs` call is made. No libc
// or system header is needed. On another architecture it lists nothing and returns -2; the probe logs the call anyway.
#if defined(__x86_64__)
static long sys3(long number, long a, long b, long c) {
  long result;
  __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
  return result;
}

int count_entries(const char *path) {
  long fd = sys3(257 /* openat */, -100 /* AT_FDCWD */, (long)path, 0200000 /* O_RDONLY | O_DIRECTORY */);
  if (fd < 0) return -1;
  char buffer[4096];
  int count = 0;
  for (;;) {
    long size = sys3(217 /* getdents64 */, fd, (long)buffer, sizeof buffer);
    if (size <= 0) break;
    for (long at = 0; at < size;) {
      count++;
      at += *(unsigned short *)(buffer + at + 16); // d_reclen
    }
  }
  sys3(3 /* close */, fd, 0, 0);
  return count;
}
#else
int count_entries(const char *path) { return -2; }
#endif
