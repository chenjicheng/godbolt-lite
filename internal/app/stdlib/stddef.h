#pragma once
#define NULL ((void *)0)
typedef __SIZE_TYPE__ size_t;
typedef __PTRDIFF_TYPE__ ptrdiff_t;
typedef __WCHAR_TYPE__ wchar_t;
typedef __WINT_TYPE__ wint_t;
#define offsetof(type, member) __builtin_offsetof(type, member)

