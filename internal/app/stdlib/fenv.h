#pragma once
typedef int fenv_t;
typedef int fexcept_t;
int feclearexcept(int);
int fegetexceptflag(fexcept_t *, int);
int feraiseexcept(int);

