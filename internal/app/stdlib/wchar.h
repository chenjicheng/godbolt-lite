#pragma once
#include <stddef.h>
typedef __WCHAR_TYPE__ wchar_t;
typedef __WINT_TYPE__ wint_t;
size_t wcslen(const wchar_t *);
wchar_t *wcscpy(wchar_t *, const wchar_t *);
int wcscmp(const wchar_t *, const wchar_t *);

