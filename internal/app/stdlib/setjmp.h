#pragma once
typedef int jmp_buf[16];
int setjmp(jmp_buf);
void longjmp(jmp_buf, int);

