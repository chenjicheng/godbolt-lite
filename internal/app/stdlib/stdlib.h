#pragma once
#include <stddef.h>
typedef struct { int quot; int rem; } div_t;
typedef struct { long quot; long rem; } ldiv_t;
typedef struct { long long quot; long long rem; } lldiv_t;
#define EXIT_FAILURE 1
#define EXIT_SUCCESS 0
void abort(void);
int abs(int);
long labs(long);
long long llabs(long long);
double atof(const char *);
int atoi(const char *);
long atol(const char *);
long long atoll(const char *);
void *calloc(size_t, size_t);
void free(void *);
void *malloc(size_t);
void *realloc(void *, size_t);
void exit(int);
int rand(void);
void srand(unsigned);
double strtod(const char *, char **);
long strtol(const char *, char **, int);
unsigned long strtoul(const char *, char **, int);
int system(const char *);

