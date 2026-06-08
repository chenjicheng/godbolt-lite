#pragma once
typedef void (*sighandler_t)(int);
#define SIGABRT 22
#define SIGFPE 8
#define SIGILL 4
#define SIGINT 2
#define SIGSEGV 11
#define SIGTERM 15
sighandler_t signal(int, sighandler_t);
int raise(int);

