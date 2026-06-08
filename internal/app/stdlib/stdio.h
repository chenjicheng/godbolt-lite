#pragma once
#include <stddef.h>
typedef struct FILE FILE;
#define NULL ((void *)0)
#define EOF (-1)
extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;
int printf(const char *, ...);
int fprintf(FILE *, const char *, ...);
int sprintf(char *, const char *, ...);
int snprintf(char *, size_t, const char *, ...);
int puts(const char *);
int putchar(int);
int scanf(const char *, ...);
FILE *fopen(const char *, const char *);
int fclose(FILE *);
size_t fread(void *, size_t, size_t, FILE *);
size_t fwrite(const void *, size_t, size_t, FILE *);
int fgetc(FILE *);
int fputc(int, FILE *);
char *fgets(char *, int, FILE *);
int fputs(const char *, FILE *);

