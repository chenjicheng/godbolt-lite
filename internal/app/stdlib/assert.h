#pragma once
#ifdef NDEBUG
#define assert(expr) ((void)0)
#else
void __mini_godbolt_assert_fail(const char *, const char *, int);
#define assert(expr) ((expr) ? (void)0 : __mini_godbolt_assert_fail(#expr, __FILE__, __LINE__))
#endif

