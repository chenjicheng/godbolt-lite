#pragma once
typedef int thrd_t;
typedef int mtx_t;
int thrd_create(thrd_t *, int (*)(void *), void *);
int thrd_join(thrd_t, int *);

